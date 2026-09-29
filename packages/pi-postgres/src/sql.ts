import { Pool, type PoolClient, type PoolConfig, type QueryResult as PgQueryResult } from "pg";

export interface SqlQueryResult<Row extends object = Record<string, unknown>> {
	readonly rows: Row[];
	readonly rowCount: number;
}

export interface SqlExecutor {
	query<Row extends object = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<SqlQueryResult<Row>>;
	transaction<T>(callback: (executor: SqlExecutor) => Promise<T>): Promise<T>;
}

function toQueryResult<Row extends object>(result: PgQueryResult<Row>): SqlQueryResult<Row> {
	return { rows: result.rows, rowCount: result.rowCount ?? 0 };
}

class PgTransactionExecutor implements SqlExecutor {
	constructor(private readonly client: PoolClient) {}

	async query<Row extends object = Record<string, unknown>>(
		text: string,
		values: readonly unknown[] = [],
	): Promise<SqlQueryResult<Row>> {
		return toQueryResult(await this.client.query<Row>(text, [...values]));
	}

	transaction<T>(_callback: (executor: SqlExecutor) => Promise<T>): Promise<T> {
		return Promise.reject(new Error("Nested SQL transactions are not supported"));
	}
}

/** PostgreSQL executor used by the PoC and replaceable by a Neon executor later. */
export class PgExecutor implements SqlExecutor {
	private readonly pool: Pool;

	constructor(config: PoolConfig) {
		this.pool = new Pool(config);
	}

	async query<Row extends object = Record<string, unknown>>(
		text: string,
		values: readonly unknown[] = [],
	): Promise<SqlQueryResult<Row>> {
		return toQueryResult(await this.pool.query<Row>(text, [...values]));
	}

	async transaction<T>(callback: (executor: SqlExecutor) => Promise<T>): Promise<T> {
		const client = await this.pool.connect();
		try {
			await client.query("BEGIN");
			const result = await callback(new PgTransactionExecutor(client));
			await client.query("COMMIT");
			return result;
		} catch (error) {
			await client.query("ROLLBACK").catch(() => undefined);
			throw error;
		} finally {
			client.release();
		}
	}

	async close(): Promise<void> {
		await this.pool.end();
	}
}
