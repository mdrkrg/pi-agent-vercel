import type { SqlTelemetry } from "../../pi-postgres/src/index.ts";
import { recordSqlMeasurement, traceStage } from "./tracing.ts";

async function measured<T>(kind: "query" | "acquire" | "transaction", run: () => Promise<T>): Promise<T> {
	const started = performance.now();
	let failed = true;
	try { const result = await run(); failed = false; return result; }
	finally { recordSqlMeasurement(kind, performance.now() - started, failed); }
}

/** Application-owned OTel adapter; the PostgreSQL package stays exporter-independent. */
export function createSqlTelemetry(detail = false): SqlTelemetry {
	return {
		query: (operation, run) => detail
			? traceStage("db.query", { "db.operation.name": operation }, () => measured("query", run)) : measured("query", run),
		acquire: (pool, run) => detail ? traceStage("db.pool.acquire", {
			"agent.db.pool.total": pool.total, "agent.db.pool.idle": pool.idle, "agent.db.pool.waiting": pool.waiting,
		}, () => measured("acquire", run)) : measured("acquire", run),
		transaction: (run) => detail ? traceStage("db.transaction", {}, () => measured("transaction", run)) : measured("transaction", run),
	};
}
