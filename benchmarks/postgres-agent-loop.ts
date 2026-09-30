import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core/harness/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import {
	PgExecutor,
	PostgresSessionRepo,
	SessionLeaseManager,
	deletePiPostgresSession,
	ensurePiPostgresSchema,
	type SqlExecutor,
	type SqlQueryResult,
} from "../packages/pi-postgres/src/index.ts";
import { acceptPrompt, driveOperation, drivePostgresOperation, openAgentHarness } from "../packages/agent-runtime/src/index.ts";

type QueryKind = "read" | "write" | "control";
type WorkloadPhase = "setup" | "admission" | "drive" | "inspect" | "teardown" | "outside";

type WorkloadContext = {
	scenario: string;
	phase: WorkloadPhase;
	transactionId?: number;
};

type QueryObservation = {
	scenario: string;
	phase: WorkloadPhase;
	kind: QueryKind;
	table: string;
	text: string;
	durationMs: number;
	rowCount: number;
	requestBytes: number;
	responseBytes: number;
	transactionId?: number;
};

type TransactionObservation = {
	transactionId: number;
	scenario: string;
	phase: WorkloadPhase;
	durationMs: number;
	queryCount: number;
	readQueries: number;
	writeQueries: number;
	failed: boolean;
};

type PgDatabaseStats = {
	datname: string;
	xact_commit: number;
	xact_rollback: number;
	blks_read: number;
	blks_hit: number;
	tup_returned: number;
	tup_fetched: number;
	tup_inserted: number;
	tup_updated: number;
	tup_deleted: number;
};

type PgActivityStats = { connections: number; active: number };

type Snapshot = {
	atMs: number;
	database: PgDatabaseStats;
	activity: PgActivityStats;
};

type ActivitySample = PgActivityStats;

type Metrics = {
	queries: QueryObservation[];
	transactions: TransactionObservation[];
	nextTransactionId: number;
	modelCalls: number;
	toolCalls: number;
	activitySamples: ActivitySample[];
	startMs: number;
	endMs: number;
	pgStart?: Snapshot;
	pgEnd?: Snapshot;
};

type ScenarioResult = {
	metrics: Metrics;
	sessionId?: string;
	sessionIds?: string[];
	failedSessions?: number;
};

const contextStorage = new AsyncLocalStorage<WorkloadContext>();

function context(): WorkloadContext {
	return contextStorage.getStore() ?? { scenario: "outside", phase: "outside" };
}

async function inContext<T>(value: WorkloadContext, callback: () => Promise<T>): Promise<T> {
	return contextStorage.run(value, callback);
}

async function inPhase<T>(phase: WorkloadPhase, callback: () => Promise<T>): Promise<T> {
	const current = context();
	return inContext({ ...current, phase }, callback);
}

function normalizeSql(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function classifySql(text: string): QueryKind {
	const keyword = normalizeSql(text).match(/^[A-Za-z]+/)?.[0]?.toUpperCase();
	if (keyword === "SELECT" || keyword === "SHOW" || keyword === "EXPLAIN" || keyword === "VALUES") return "read";
	if (keyword === "BEGIN" || keyword === "COMMIT" || keyword === "ROLLBACK" || keyword === "SET") return "control";
	return "write";
}

function tableForSql(text: string): string {
	const normalized = normalizeSql(text);
	const match = normalized.match(/\b(?:FROM|INTO|UPDATE|TABLE|JOIN)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?([A-Za-z_][A-Za-z0-9_.]*)/i);
	return match?.[1] ?? "<none>";
}

function jsonBytes(value: unknown): number {
	try {
		return Buffer.byteLength(JSON.stringify(value) ?? "null");
	} catch {
		return 0;
	}
}

function percentile(values: number[], p: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
	return sorted[index] ?? 0;
}

function delta(after: number, before: number): number {
	return after - before;
}

class MeteredExecutor implements SqlExecutor {
	constructor(
		private readonly delegate: SqlExecutor,
		private readonly metrics: Metrics,
		private readonly txId?: number,
	) {}

	async query<Row extends object = Record<string, unknown>>(
		text: string,
		values: readonly unknown[] = [],
	): Promise<SqlQueryResult<Row>> {
		const started = performance.now();
		try {
			const result = await this.delegate.query<Row>(text, values);
			this.record(text, values, result.rowCount, result.rows ?? [], performance.now() - started);
			return result;
		} catch (error) {
			this.record(text, values, 0, [], performance.now() - started);
			throw error;
		}
	}

	async transaction<T>(callback: (executor: SqlExecutor) => Promise<T>): Promise<T> {
		const started = performance.now();
		const transactionId = this.metrics.nextTransactionId++;
		const transactionContext = { ...context(), transactionId };
		let failed = false;
		try {
			return await inContext(transactionContext, () =>
				this.delegate.transaction((executor) => callback(new MeteredExecutor(executor, this.metrics, transactionId))),
			);
		} catch (error) {
			failed = true;
			throw error;
		} finally {
			const queries = this.metrics.queries.filter((query) => query.transactionId === transactionId);
			this.metrics.transactions.push({
				transactionId,
				scenario: transactionContext.scenario,
				phase: transactionContext.phase,
				durationMs: performance.now() - started,
				queryCount: queries.length,
				readQueries: queries.filter((query) => query.kind === "read").length,
				writeQueries: queries.filter((query) => query.kind === "write").length,
				failed,
			});
		}
	}

	private record<Row extends object>(
		text: string,
		values: readonly unknown[],
		rowCount: number,
		rows: readonly Row[],
		durationMs: number,
	): void {
		const current = context();
		this.metrics.queries.push({
			scenario: current.scenario,
			phase: current.phase,
			kind: classifySql(text),
			table: tableForSql(text),
			text: normalizeSql(text),
			durationMs,
			rowCount,
			requestBytes: Buffer.byteLength(text) + values.reduce((total: number, value) => total + jsonBytes(value), 0),
			responseBytes: rows.reduce((total: number, row) => total + jsonBytes(row), 0),
			...(this.txId === undefined ? {} : { transactionId: this.txId }),
		});
	}
}

async function pgSnapshot(pool: Pool): Promise<Snapshot> {
	const [database, activity] = await Promise.all([
		pool.query<PgDatabaseStats>(
			`SELECT datname, xact_commit::bigint, xact_rollback::bigint, blks_read::bigint, blks_hit::bigint,
				tup_returned::bigint, tup_fetched::bigint, tup_inserted::bigint, tup_updated::bigint, tup_deleted::bigint
			 FROM pg_stat_database WHERE datname = current_database()`,
		),
		readActivity(pool),
	]);
	const row = database.rows[0];
	if (row === undefined) throw new Error("pg_stat_database did not return the current database");
	const numeric = (value: number | string): number => Number(value);
	return {
		atMs: Date.now(),
		database: {
			datname: row.datname,
			xact_commit: numeric(row.xact_commit),
			xact_rollback: numeric(row.xact_rollback),
			blks_read: numeric(row.blks_read),
			blks_hit: numeric(row.blks_hit),
			tup_returned: numeric(row.tup_returned),
			tup_fetched: numeric(row.tup_fetched),
			tup_inserted: numeric(row.tup_inserted),
			tup_updated: numeric(row.tup_updated),
			tup_deleted: numeric(row.tup_deleted),
		},
		activity,
	};
}

async function readActivity(pool: Pool): Promise<PgActivityStats> {
	const result = await pool.query<{ connections: string; active: string }>(
		`SELECT count(*) FILTER (WHERE pid <> pg_backend_pid())::text AS connections,
			count(*) FILTER (WHERE pid <> pg_backend_pid() AND state = 'active')::text AS active
		 FROM pg_stat_activity WHERE datname = current_database()`,
	);
	return {
		connections: Number(result.rows[0]?.connections ?? 0),
		active: Number(result.rows[0]?.active ?? 0),
	};
}

function makeMetrics(): Metrics {
	return {
		queries: [],
		transactions: [],
		nextTransactionId: 0,
		modelCalls: 0,
		toolCalls: 0,
		activitySamples: [],
		startMs: performance.now(),
		endMs: performance.now(),
	};
}

function makeResponses(iterations: number, tool: boolean): ReturnType<typeof fauxAssistantMessage>[] {
	const responses = [] as ReturnType<typeof fauxAssistantMessage>[];
	for (let index = 0; index < iterations; index++) {
		if (tool) {
			responses.push(fauxAssistantMessage(fauxToolCall("echo", { value: `value-${index}` }, { id: `tool-${index}` })));
			responses.push(fauxAssistantMessage(`tool response ${index}`));
		} else {
			responses.push(fauxAssistantMessage(`response ${index}`));
		}
	}
	return responses;
}

function fauxTokensPerSecond(): number {
	const value = Number(process.env.POC_FAUX_TPS ?? 1_000_000);
	if (!Number.isFinite(value) || value <= 0) throw new Error("POC_FAUX_TPS must be positive");
	return value;
}

function storageCommitStats(metrics: Metrics): { commits: number; writes: number } {
	const commitIds = new Set(
		metrics.queries
			.filter((query) => query.transactionId !== undefined && query.table === "pi_poc_storage_sequences" && query.kind === "write")
			.map((query) => query.transactionId),
	);
	const writes = metrics.queries.filter(
		(query) =>
			query.transactionId !== undefined &&
			commitIds.has(query.transactionId) &&
			/^pi_poc_storage_(entries|usage|values|lists)$/.test(query.table) &&
			query.kind === "write",
	).length;
	return { commits: commitIds.size, writes };
}

async function persistentScenario(
	scenario: string,
	iterations: number,
	tool: boolean,
	databaseUrl: string,
	): Promise<ScenarioResult> {
	const metrics = makeMetrics();
	const raw = new PgExecutor({ connectionString: databaseUrl });
	const metered = new MeteredExecutor(raw, metrics);
	const repo = new PostgresSessionRepo(metered);
	const leases = new SessionLeaseManager(metered);
	const sessionId = `bench-${scenario}-${randomUUID()}`;
	let modelCalls = 0;
	await inContext({ scenario, phase: "setup" }, async () => {
		const lease = await leases.acquire(sessionId, { holderId: `bench-${scenario}`, ttlMs: 60_000 });
		const session = await repo.createWithLease({ id: sessionId }, lease, BACKGROUND_CONTEXT);
		try {
			const models = createModels();
			const faux = fauxProvider({ tokensPerSecond: fauxTokensPerSecond() });
			models.setProvider(faux.provider);
			faux.setResponses(makeResponses(iterations, tool));
			const toolDefinition = tool
				? ({
					name: "echo",
					label: "Echo",
					description: "Return the supplied value",
					parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
					replay: "never",
					execute: async (toolCallId: string, params: { value: string }) => {
						metrics.toolCalls += 1;
						return { content: [{ type: "text", text: `${toolCallId}:${params.value}` }] };
					},
				} as unknown as import("@earendil-works/pi-agent-core").AgentHarnessTool<undefined>)
				: undefined;
			const opened = await openAgentHarness(
				{ session, models, model: faux.getModel(), ...(toolDefinition === undefined ? {} : { tools: [toolDefinition] }) },
				BACKGROUND_CONTEXT,
			);
			try {
				const lane = await opened.harness.lane("main", BACKGROUND_CONTEXT);
				for (let index = 0; index < iterations; index++) {
					const admission = await inPhase("admission", () => acceptPrompt(lane, `prompt ${index}`, BACKGROUND_CONTEXT));
					if (!admission.ok) throw admission.error;
					const driven = await inPhase("drive", () => driveOperation(lane, admission.value.operationId, BACKGROUND_CONTEXT));
					if (!driven.ok || driven.value.kind !== "settled") throw new Error(`drive failed: ${JSON.stringify(driven)}`);
				}
				modelCalls = faux.state.callCount;
				await inPhase("inspect", async () => {
					await lane.findEntries({ order: "oldestFirst" }, BACKGROUND_CONTEXT);
				});
			} finally {
				await inPhase("teardown", () => opened.harness.close(BACKGROUND_CONTEXT));
			}
		} finally {
			await inPhase("teardown", () => session.close(BACKGROUND_CONTEXT));
			await inPhase("teardown", () => leases.release(lease));
			}
		});
	metrics.modelCalls = modelCalls;
	metrics.endMs = performance.now();
	await raw.close();
	return { metrics, sessionId };
}

async function concurrentPersistentScenario(
	scenario: string,
	concurrency: number,
	iterations: number,
	databaseUrl: string,
	poolMax: number,
): Promise<ScenarioResult> {
	const metrics = makeMetrics();
	const raw = new PgExecutor({ connectionString: databaseUrl, max: poolMax });
	const metered = new MeteredExecutor(raw, metrics);
	const repo = new PostgresSessionRepo(metered);
	const leases = new SessionLeaseManager(metered);
	const sessionIds = Array.from({ length: concurrency }, (_, index) => `bench-${scenario}-${index}-${randomUUID()}`);
	const activityPool = new Pool({ connectionString: databaseUrl, max: 1 });
	let sampling = true;
	const sampler = (async () => {
		while (sampling) {
			try {
				metrics.activitySamples.push(await readActivity(activityPool));
			} catch {
				// The sample is advisory; query failures are already reflected by the workload result.
			}
			await new Promise<void>((resolve) => setTimeout(resolve, 25));
		}
	})();

	const runSession = async (index: number): Promise<void> => {
		const sessionId = sessionIds[index]!;
		await inContext({ scenario, phase: "setup" }, async () => {
			let lease: Awaited<ReturnType<SessionLeaseManager["acquire"]>> | undefined;
			let session: Awaited<ReturnType<PostgresSessionRepo["openWithLease"]>> | undefined;
			let opened: Awaited<ReturnType<typeof openAgentHarness>> | undefined;
			const models = createModels();
			const faux = fauxProvider({ tokensPerSecond: fauxTokensPerSecond() });
			models.setProvider(faux.provider);
			faux.setResponses(makeResponses(iterations, false));
			try {
				lease = await leases.acquire(sessionId, { holderId: `bench-${scenario}-${index}`, ttlMs: 60_000 });
				session = await repo.createWithLease({ id: sessionId }, lease, BACKGROUND_CONTEXT);
				opened = await openAgentHarness({ session, models, model: faux.getModel() }, BACKGROUND_CONTEXT);
				const lane = await opened.harness.lane("main", BACKGROUND_CONTEXT);
				for (let turn = 0; turn < iterations; turn++) {
					const admission = await inPhase("admission", () => acceptPrompt(lane, `prompt ${turn}`, BACKGROUND_CONTEXT));
					if (!admission.ok) throw admission.error;
					const driven = await inPhase("drive", () => driveOperation(lane, admission.value.operationId, BACKGROUND_CONTEXT));
					if (!driven.ok || driven.value.kind !== "settled") throw new Error(`drive failed: ${JSON.stringify(driven)}`);
				}
				metrics.modelCalls += faux.state.callCount;
			} finally {
				try {
					if (opened !== undefined) await inPhase("teardown", () => opened!.harness.close(BACKGROUND_CONTEXT));
				} finally {
					try {
						if (session !== undefined) await inPhase("teardown", () => session!.close(BACKGROUND_CONTEXT));
					} finally {
						if (lease !== undefined) await inPhase("teardown", () => leases.release(lease!));
					}
				}
			}
		});
	};

	const settled = await Promise.allSettled(sessionIds.map((_, index) => runSession(index)));
	sampling = false;
	await sampler;
	await activityPool.end();
	metrics.endMs = performance.now();
	await repo.close(BACKGROUND_CONTEXT);
	await raw.close();
	return {
		metrics,
		sessionIds,
		failedSessions: settled.filter((result) => result.status === "rejected").length,
	};
}

async function freshDriveScenario(
	scenario: string,
	iterations: number,
	databaseUrl: string,
	): Promise<ScenarioResult> {
	const metrics = makeMetrics();
	const raw = new PgExecutor({ connectionString: databaseUrl });
	const metered = new MeteredExecutor(raw, metrics);
	const repo = new PostgresSessionRepo(metered);
	const leases = new SessionLeaseManager(metered);
	const sessionId = `bench-${scenario}-${randomUUID()}`;
	let metadata!: { id: string; createdAt: number; storageVersion: number };
	let modelCalls = 0;
	await inContext({ scenario, phase: "setup" }, async () => {
		const lease = await leases.acquire(sessionId, { holderId: `bench-${scenario}-create`, ttlMs: 60_000 });
		const session = await repo.createWithLease({ id: sessionId }, lease, BACKGROUND_CONTEXT);
		metadata = session.metadata;
		await session.close(BACKGROUND_CONTEXT);
		await leases.release(lease);
		const models = createModels();
		const faux = fauxProvider({ tokensPerSecond: fauxTokensPerSecond() });
		models.setProvider(faux.provider);
		faux.setResponses(makeResponses(iterations, false));
		for (let index = 0; index < iterations; index++) {
			const admitLease = await leases.acquire(sessionId, { holderId: `bench-${scenario}-admit-${index}`, ttlMs: 60_000 });
			const admittedSession = await repo.openWithLease(metadata, admitLease, BACKGROUND_CONTEXT);
			const opened = await openAgentHarness({ session: admittedSession, models, model: faux.getModel() }, BACKGROUND_CONTEXT);
			const lane = await opened.harness.lane("main", BACKGROUND_CONTEXT);
			const admission = await inPhase("admission", () => acceptPrompt(lane, `prompt ${index}`, BACKGROUND_CONTEXT));
			if (!admission.ok) throw admission.error;
			await opened.harness.close(BACKGROUND_CONTEXT);
			await admittedSession.close(BACKGROUND_CONTEXT);
			await leases.release(admitLease);
			const driven = await inPhase("drive", () =>
				drivePostgresOperation(
					{ repo, leases, session: metadata, models, model: faux.getModel(), lease: { holderId: `bench-${scenario}-drive-${index}`, ttlMs: 60_000 } },
					admission.value.operationId,
					BACKGROUND_CONTEXT,
				),
			);
			if (!driven.ok || driven.value.kind !== "settled") throw new Error(`drive failed: ${JSON.stringify(driven)}`);
			modelCalls = faux.state.callCount;
		}
	});
	metrics.modelCalls = modelCalls;
	metrics.endMs = performance.now();
	await raw.close();
	return { metrics, sessionId };
}

function summarize(metrics: Metrics) {
	const elapsedMs = metrics.endMs - metrics.startMs;
	const commitStats = storageCommitStats(metrics);
	const sampledActivity = metrics.activitySamples.length === 0
		? undefined
		: {
			peakConnections: Math.max(...metrics.activitySamples.map((sample) => sample.connections)),
			peakActiveConnections: Math.max(...metrics.activitySamples.map((sample) => sample.active)),
			samples: metrics.activitySamples.length,
		};
	const byPhase = [...new Set(metrics.queries.map((query) => query.phase))].sort().map((phase) => {
		const queries = metrics.queries.filter((query) => query.phase === phase);
		const durations = queries.map((query) => query.durationMs);
		return {
			phase,
			queries: queries.length,
			reads: queries.filter((query) => query.kind === "read").length,
			writes: queries.filter((query) => query.kind === "write").length,
			control: queries.filter((query) => query.kind === "control").length,
			transactions: metrics.transactions.filter((transaction) => transaction.phase === phase).length,
			qps: elapsedMs === 0 ? 0 : (queries.length * 1_000) / elapsedMs,
			p50QueryMs: percentile(durations, 0.5),
			p95QueryMs: percentile(durations, 0.95),
			p99QueryMs: percentile(durations, 0.99),
		};
	});
	const tableCounts = new Map<string, number>();
	for (const query of metrics.queries) tableCounts.set(query.table, (tableCounts.get(query.table) ?? 0) + 1);
	return {
		elapsedMs,
		queries: metrics.queries.length,
		reads: metrics.queries.filter((query) => query.kind === "read").length,
		writes: metrics.queries.filter((query) => query.kind === "write").length,
		transactions: metrics.transactions.length,
		failedTransactions: metrics.transactions.filter((transaction) => transaction.failed).length,
		commits: commitStats.commits,
		commitWrites: commitStats.writes,
		averageWritesPerCommit: commitStats.commits === 0 ? 0 : commitStats.writes / commitStats.commits,
		modelCalls: metrics.modelCalls,
		toolCalls: metrics.toolCalls,
		...(sampledActivity === undefined ? {} : { sampledActivity }),
		queriesPerSecond: elapsedMs === 0 ? 0 : (metrics.queries.length * 1_000) / elapsedMs,
		queriesPerCommit: commitStats.commits === 0 ? 0 : metrics.queries.length / commitStats.commits,
		byPhase,
		tableCounts: Object.fromEntries([...tableCounts.entries()].sort((a, b) => b[1] - a[1])),
		queryLatencyMs: {
			p50: percentile(metrics.queries.map((query) => query.durationMs), 0.5),
			p95: percentile(metrics.queries.map((query) => query.durationMs), 0.95),
			p99: percentile(metrics.queries.map((query) => query.durationMs), 0.99),
		},
		transactionLatencyMs: {
			p50: percentile(metrics.transactions.map((transaction) => transaction.durationMs), 0.5),
			p95: percentile(metrics.transactions.map((transaction) => transaction.durationMs), 0.95),
			p99: percentile(metrics.transactions.map((transaction) => transaction.durationMs), 0.99),
		},
	};
}

function summarizePg(before: Snapshot | undefined, after: Snapshot | undefined) {
	if (before === undefined || after === undefined) return undefined;
	const b = before.database;
	const a = after.database;
	const blocks = delta(a.blks_read, b.blks_read) + delta(a.blks_hit, b.blks_hit);
	return {
		elapsedMs: after.atMs - before.atMs,
		xactCommit: delta(a.xact_commit, b.xact_commit),
		xactRollback: delta(a.xact_rollback, b.xact_rollback),
		blocksRead: delta(a.blks_read, b.blks_read),
		blocksHit: delta(a.blks_hit, b.blks_hit),
		bufferHitRatio: blocks === 0 ? 1 : delta(a.blks_hit, b.blks_hit) / blocks,
		tuplesReturned: delta(a.tup_returned, b.tup_returned),
		tuplesFetched: delta(a.tup_fetched, b.tup_fetched),
		tuplesInserted: delta(a.tup_inserted, b.tup_inserted),
		tuplesUpdated: delta(a.tup_updated, b.tup_updated),
		tuplesDeleted: delta(a.tup_deleted, b.tup_deleted),
		peakConnections: Math.max(before.activity.connections, after.activity.connections),
		peakActiveConnections: Math.max(before.activity.active, after.activity.active),
	};
}

async function main(): Promise<void> {
	const databaseUrl = process.env.DATABASE_URL;
	if (databaseUrl === undefined) throw new Error("DATABASE_URL is required");
	const iterations = Number(process.env.POC_BENCH_ITERATIONS ?? 10);
	if (!Number.isSafeInteger(iterations) || iterations < 1) throw new Error("POC_BENCH_ITERATIONS must be a positive integer");
	const concurrency = process.env.POC_BENCH_CONCURRENCY === undefined ? undefined : Number(process.env.POC_BENCH_CONCURRENCY);
	if (concurrency !== undefined && (!Number.isSafeInteger(concurrency) || concurrency < 1)) {
		throw new Error("POC_BENCH_CONCURRENCY must be a positive integer");
	}
	const concurrentIterations = Number(process.env.POC_BENCH_CONCURRENT_TURNS ?? iterations);
	if (!Number.isSafeInteger(concurrentIterations) || concurrentIterations < 1) {
		throw new Error("POC_BENCH_CONCURRENT_TURNS must be a positive integer");
	}
	const defaultPoolMax = concurrency === undefined ? 10 : Math.min(90, Math.max(10, concurrency));
	const poolMax = Number(process.env.POC_BENCH_POOL_MAX ?? defaultPoolMax);
	if (!Number.isSafeInteger(poolMax) || poolMax < 1) throw new Error("POC_BENCH_POOL_MAX must be a positive integer");
	const raw = new PgExecutor({ connectionString: databaseUrl });
	await ensurePiPostgresSchema(raw);
	await raw.close();
	const statsPool = new Pool({ connectionString: databaseUrl });
	const scenarios = concurrency === undefined
		? [
				{ name: "one-turn", run: () => persistentScenario("one-turn", 1, false, databaseUrl) },
				{ name: `persistent-${iterations}-turn`, run: () => persistentScenario(`persistent-${iterations}-turn`, iterations, false, databaseUrl) },
				{ name: "tool-turn", run: () => persistentScenario("tool-turn", 1, true, databaseUrl) },
				{ name: `fresh-drive-${iterations}-turn`, run: () => freshDriveScenario(`fresh-drive-${iterations}-turn`, iterations, databaseUrl) },
			]
		: [{
				name: `concurrent-${concurrency}-session-${concurrentIterations}-turn`,
				run: () => concurrentPersistentScenario(`concurrent-${concurrency}-session-${concurrentIterations}-turn`, concurrency, concurrentIterations, databaseUrl, poolMax),
			}];
	const report: Record<string, unknown> = {
		generatedAt: new Date().toISOString(),
		iterations,
		...(concurrency === undefined ? {} : { concurrency, concurrentIterations, poolMax }),
		metrics: {
			queryClassification: "SELECT/SHOW/EXPLAIN/VALUES are reads; BEGIN/COMMIT/ROLLBACK/SET are control; other statements are writes",
			pgStats: "delta of pg_stat_database and pg_stat_activity around each scenario",
		},
		scenarios: [],
	};
	for (const scenario of scenarios) {
		const before = await pgSnapshot(statsPool);
		const result = await scenario.run();
		const after = await pgSnapshot(statsPool);
		result.metrics.pgStart = before;
		result.metrics.pgEnd = after;
		(report.scenarios as unknown[]).push({
			name: scenario.name,
			summary: summarize(result.metrics),
			postgres: summarizePg(before, after),
			...(result.sessionId === undefined ? {} : { sessionId: result.sessionId }),
			...(result.sessionIds === undefined ? {} : { sessionCount: result.sessionIds.length }),
			...(result.failedSessions === undefined ? {} : { failedSessions: result.failedSessions }),
		});
		const sessionIds = result.sessionIds ?? (result.sessionId === undefined ? [] : [result.sessionId]);
		const cleanup = new PgExecutor({ connectionString: databaseUrl, max: Math.min(10, poolMax) });
		for (const sessionId of sessionIds) await deletePiPostgresSession(cleanup, sessionId);
		await cleanup.close();
	}
	await statsPool.end();
	process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

await main();
