import { Pool, type PoolClient, type PoolConfig, type QueryResult as PgQueryResult } from "pg";

export interface SqlQueryResult<Row extends object = Record<string, unknown>> {
	readonly rows: Row[];
	readonly rowCount: number;
}

export interface SqlExecutor {
	query<Row extends object = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<SqlQueryResult<Row>>;
	transaction<T>(callback: (executor: SqlExecutor) => Promise<T>): Promise<T>;
}

const statementOperations = ["SELECT", "INSERT", "UPDATE", "DELETE", "WITH", "BEGIN", "COMMIT", "ROLLBACK"] as const;
export type SqlOperation = typeof statementOperations[number] | "DDL" | "OTHER";
export type PoolSnapshot = { total: number; idle: number; waiting: number };
/** No statement, parameters, connection configuration or exceptions cross this port. */
export interface SqlTelemetry {
	query<T>(operation: SqlOperation, run: () => Promise<T>): Promise<T>;
	acquire<T>(pool: PoolSnapshot, run: () => Promise<T>): Promise<T>;
	transaction<T>(run: () => Promise<T>): Promise<T>;
}

function operation(text: string): SqlOperation {
	const verb = /^\s*([a-z]+)/i.exec(text)?.[1]?.toUpperCase();
	if (["CREATE", "ALTER", "DROP", "TRUNCATE"].includes(verb ?? "")) return "DDL";
	return statementOperations.find((operation) => operation === verb) ?? "OTHER";
}

/** Telemetry must neither replace results/errors nor run a SQL effect twice. */
async function observe<T>(run: () => Promise<T>, instrument?: (run: () => Promise<T>) => Promise<T>): Promise<T> {
	let execution: Promise<T> | undefined;
	const once = () => execution ??= run();
	try { void instrument?.(once).catch(() => undefined); } catch { /* Recover the original execution below. */ }
	return once();
}

function toQueryResult<Row extends object>(result: PgQueryResult<Row>): SqlQueryResult<Row> {
	return { rows: result.rows, rowCount: result.rowCount ?? 0 };
}

/** Like Pool.query, handle an in-flight client error instead of leaving it unhandled. */
function clientQuery<Row extends object>(client: PoolClient, text: string, values: readonly unknown[]): Promise<SqlQueryResult<Row>> {
	return new Promise((resolve, reject) => {
		const onError = (error: Error) => reject(error);
		client.once("error", onError);
		const cleanup = () => client.removeListener("error", onError);
		try {
			void client.query<Row>(text, [...values]).then((result) => { cleanup(); resolve(toQueryResult(result)); }, (error: unknown) => { cleanup(); reject(error); });
		} catch (error) { cleanup(); reject(error); }
	});
}

class PgTransactionExecutor implements SqlExecutor {
	constructor(private readonly client: PoolClient, private readonly telemetry?: SqlTelemetry) {}

	async query<Row extends object = Record<string, unknown>>(
		text: string,
		values: readonly unknown[] = [],
	): Promise<SqlQueryResult<Row>> {
		return observe(() => clientQuery<Row>(this.client, text, values),
			this.telemetry === undefined ? undefined : (run) => this.telemetry!.query(operation(text), run));
	}

	transaction<T>(_callback: (executor: SqlExecutor) => Promise<T>): Promise<T> {
		return Promise.reject(new Error("Nested SQL transactions are not supported"));
	}
}

/** PostgreSQL executor used by the PoC and replaceable by a Neon executor later. */
export class PgExecutor implements SqlExecutor {
	private readonly pool: Pool;

	constructor(config: PoolConfig, private readonly telemetry?: SqlTelemetry) {
		this.pool = new Pool(config);
	}

	private acquire(): Promise<PoolClient> {
		return observe(() => this.pool.connect(), this.telemetry === undefined ? undefined
			: (run) => this.telemetry!.acquire({ total: this.pool.totalCount, idle: this.pool.idleCount, waiting: this.pool.waitingCount }, run));
	}

	async query<Row extends object = Record<string, unknown>>(
		text: string,
		values: readonly unknown[] = [],
	): Promise<SqlQueryResult<Row>> {
		if (this.telemetry === undefined) return toQueryResult(await this.pool.query<Row>(text, [...values]));
		const client = await this.acquire();
		let failure: Error | boolean | undefined;
		try { return await new PgTransactionExecutor(client, this.telemetry).query<Row>(text, values); }
		catch (error) { failure = error instanceof Error ? error : true; throw error; }
		finally { client.release(failure); }
	}

	async transaction<T>(callback: (executor: SqlExecutor) => Promise<T>): Promise<T> {
		return observe(() => this.runTransaction(callback), this.telemetry === undefined ? undefined : (run) => this.telemetry!.transaction(run));
	}

	private async runTransaction<T>(callback: (executor: SqlExecutor) => Promise<T>): Promise<T> {
		const client = await this.acquire();
		const transaction = new PgTransactionExecutor(client, this.telemetry);
		try {
			await transaction.query("BEGIN");
			const result = await callback(transaction);
			await transaction.query("COMMIT");
			return result;
		} catch (error) {
			await transaction.query("ROLLBACK").catch(() => undefined);
			throw error;
		} finally {
			client.release();
		}
	}

	async close(): Promise<void> {
		await this.pool.end();
	}
}
