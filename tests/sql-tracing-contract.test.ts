import type { PoolConfig } from "pg";
import { SpanStatusCode } from "@opentelemetry/api";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { PgExecutor, type SqlTelemetry } from "../packages/pi-postgres/src/index.ts";
import { createSqlTelemetry } from "../packages/agent-runtime/src/sql-tracing.ts";
import { traceStage } from "../packages/agent-runtime/src/tracing.ts";
import { contentFreeSpanProcessor } from "../packages/agent-runtime/src/telemetry-policy.ts";
import { captureTracing } from "./fixtures/tracing.ts";

const mocks = vi.hoisted(() => {
	const query = vi.fn(async (_text: string, _values: unknown[]) => ({ rows: [{ value: "private-row" }], rowCount: 1 }));
	const release = vi.fn();
	const once = vi.fn((_event: string, _listener: (error: Error) => void) => undefined);
	const removeListener = vi.fn();
	const client = { query, release, once, removeListener };
	const connect = vi.fn(async () => client);
	return { query, release, client, connect, once, removeListener, end: vi.fn(async () => undefined) };
});
vi.mock("pg", () => ({ Pool: class {
	totalCount = 2; idleCount = 1; waitingCount = 3;
	constructor(_config: PoolConfig) {}
	connect = mocks.connect; end = mocks.end;
} }));
const capture = captureTracing([contentFreeSpanProcessor]);
afterEach(() => { capture.exporter.reset(); vi.clearAllMocks(); });
afterAll(() => capture.close());
const executor = (telemetry: SqlTelemetry = createSqlTelemetry(true)) => new PgExecutor({ connectionString: "postgres://private-connection" }, telemetry);
const exported = () => JSON.stringify(capture.exporter.getFinishedSpans().map((span) => ({ name: span.name, attributes: span.attributes, events: span.events, status: span.status })));

describe("content-free SQL tracing", () => {
	it("keeps lightweight summaries without emitting SQL detail by default", async () => {
		await traceStage("job.drive", {}, () => executor(createSqlTelemetry()).transaction((transaction) => transaction.query("SELECT 1")));
		const spans = capture.exporter.getFinishedSpans();
		expect(spans.map((span) => span.name)).toEqual(["job.drive"]);
		expect(spans[0]!.attributes).toMatchObject({ "agent.db.query.count": 3, "agent.db.acquire.count": 1, "agent.db.transaction.count": 1 });
	});

	it("separates checkout, transaction and statements, with ancestor summaries", async () => {
		const result = await traceStage("worker.tick", {}, () => traceStage("job.drive", {}, () => executor().transaction(async (transaction) => {
			return transaction.query("SELECT $1 AS private_alias", ["private-parameter"]);
		})));
		expect(result).toEqual({ rows: [{ value: "private-row" }], rowCount: 1 });
		expect(mocks.query.mock.calls.map(([text]) => text)).toEqual(["BEGIN", "SELECT $1 AS private_alias", "COMMIT"]);
		expect(mocks.release).toHaveBeenCalledOnce();
		const spans = capture.exporter.getFinishedSpans();
		const transaction = spans.find((span) => span.name === "db.transaction")!;
		expect(spans.filter((span) => span.name === "db.query").map((span) => span.attributes["db.operation.name"])).toEqual(["BEGIN", "SELECT", "COMMIT"]);
		for (const span of spans.filter((span) => span.name === "db.query" || span.name === "db.pool.acquire")) {
			expect(span.parentSpanContext?.spanId).toBe(transaction.spanContext().spanId);
		}
		expect(spans.find((span) => span.name === "db.pool.acquire")!.attributes).toEqual({ "agent.db.pool.total": 2, "agent.db.pool.idle": 1, "agent.db.pool.waiting": 3 });
		for (const name of ["worker.tick", "job.drive"]) {
			const attributes = spans.find((span) => span.name === name)!.attributes;
			expect(attributes).toMatchObject({ "agent.db.query.count": 3, "agent.db.acquire.count": 1, "agent.db.transaction.count": 1 });
			expect(attributes["agent.db.query.total_ms"]).toBeGreaterThanOrEqual(0);
		}
		expect(exported()).not.toMatch(/private-|postgres:\/\/|SELECT \$1/);
	});

	it("counts rollback and preserves the original failure even if rollback fails", async () => {
		const failure = new Error("private-database-error");
		mocks.query.mockRejectedValueOnce(failure).mockRejectedValueOnce(new Error("private-rollback-error"));
		await expect(traceStage("job.drive", {}, () => executor().transaction(async () => "unused"))).rejects.toBe(failure);
		expect(mocks.query.mock.calls.map(([text]) => text)).toEqual(["BEGIN", "ROLLBACK"]);
		expect(mocks.release).toHaveBeenCalledOnce();
		const spans = capture.exporter.getFinishedSpans();
		expect(spans.find((span) => span.name === "job.drive")!.attributes).toMatchObject({ "agent.db.query.count": 2, "agent.db.query.error.count": 2, "agent.db.transaction.error.count": 1 });
		expect(spans.find((span) => span.name === "db.transaction")!.status.code).toBe(SpanStatusCode.ERROR);
		expect(exported()).not.toContain("private-");
	});

	it("does not run a query or release a nonexistent client on checkout failure", async () => {
		const failure = new Error("private-connection-timeout");
		mocks.connect.mockRejectedValueOnce(failure);
		await expect(traceStage("job.drive", {}, () => executor().query("SELECT 1"))).rejects.toBe(failure);
		expect(mocks.query).not.toHaveBeenCalled(); expect(mocks.release).not.toHaveBeenCalled();
		expect(capture.exporter.getFinishedSpans().find((span) => span.name === "job.drive")!.attributes).toMatchObject({ "agent.db.acquire.count": 1, "agent.db.acquire.error.count": 1 });
	});

	it("handles an in-flight connection error, discards the client and keeps the error identity", async () => {
		mocks.query.mockImplementationOnce(() => new Promise(() => undefined));
		const failure = new Error("private-socket-error");
		const sql = executor();
		const running = sql.query("SELECT 1");
		const rejection = expect(running).rejects.toBe(failure);
		await new Promise<void>((resolve) => setImmediate(resolve));
		mocks.once.mock.calls.at(-1)![1](failure);
		await rejection;
		expect(mocks.release).toHaveBeenCalledWith(failure);
		expect(capture.exporter.getFinishedSpans().find((span) => span.name === "db.query")!.status.code).toBe(SpanStatusCode.ERROR);
	});

	it("isolates summaries between concurrent requests", async () => {
		await Promise.all([1, 2].map((count) => traceStage("function.request", {}, async () => {
			for (let index = 0; index < count; index++) await executor().query("SELECT 1");
		})));
		expect(capture.exporter.getFinishedSpans().filter((span) => span.name === "function.request").map((span) => span.attributes["agent.db.query.count"]).sort()).toEqual([1, 2]);
	});

	it.each(["before", "after", "twice"])("keeps SQL exactly once when the telemetry port fails %s", async (when) => {
		const instrument = async <T>(run: () => Promise<T>): Promise<T> => {
			if (when !== "before") await run();
			if (when === "twice") await run();
			throw new Error("private-telemetry-error");
		};
		const sql = executor({ acquire: (_pool, run) => instrument(run), query: (_operation, run) => instrument(run), transaction: instrument });
		expect(await sql.transaction((transaction) => transaction.query("SELECT 1"))).toMatchObject({ rowCount: 1 });
		expect(mocks.connect).toHaveBeenCalledOnce();
		expect(mocks.query).toHaveBeenCalledTimes(3);
		expect(mocks.release).toHaveBeenCalledOnce();
	});

	it("does not wait for a hung observer", async () => {
		const hung = <T>(_run: () => Promise<T>): Promise<T> => new Promise(() => undefined);
		const sql = executor({ acquire: (_pool, run) => hung(run), query: (_operation, run) => hung(run), transaction: hung });
		expect(await sql.transaction((transaction) => transaction.query("SELECT 1"))).toMatchObject({ rowCount: 1 });
		expect(mocks.query).toHaveBeenCalledTimes(3); expect(mocks.release).toHaveBeenCalledOnce();
	});
});
