import { Readable, Writable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import handler from "../api/index.ts";
import { deletePiPostgresSession, PgExecutor } from "../packages/pi-postgres/src/index.ts";
import { captureTracing } from "./fixtures/tracing.ts";

// Test the real Function/worker with a memory exporter, never an inherited cloud exporter.
vi.mock("../packages/agent-runtime/src/telemetry-bootstrap.ts", () => ({}));
const databaseUrl = process.env.DATABASE_URL;
class Response extends Writable {
	statusCode = 200; data = "";
	setHeader(_name: string, _value: string) {}
	_write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void) { this.data += chunk.toString(); callback(); }
}

describe.skipIf(databaseUrl === undefined)("Function tracing over isolated PostgreSQL", () => {
	const executor = new PgExecutor({ connectionString: databaseUrl });
	const sessions: string[] = [];
	let capture: ReturnType<typeof captureTracing>;
	beforeAll(() => {
		capture = captureTracing();
		for (const [key, value] of Object.entries({
			DATABASE_URL: databaseUrl!, APP_API_TOKEN: "private-api-token", CRON_SECRET: "private-worker-token",
			APP_USER_ID: "private-user", APP_TENANT_ID: "private-tenant", AGENT_FAUX_RESPONSE: "private-answer",
		})) vi.stubEnv(key, value);
	});
	afterEach(async () => {
		for (const session of sessions.splice(0)) await deletePiPostgresSession(executor, session);
		capture.exporter.reset();
	});
	afterAll(async () => { vi.unstubAllEnvs(); await capture.close(); await executor.close(); });

	async function invoke(url: string, method = "GET", body?: unknown, token = "private-api-token") {
		const req = Object.assign(Readable.from([]), {
			url, method, body, headers: { authorization: `Bearer ${token}`, "idempotency-key": "private-retry-key" },
		});
		const res = new Response();
		await handler(req as unknown as IncomingMessage, res as unknown as ServerResponse);
		return { status: res.statusCode, body: JSON.parse(res.data) };
	}

	it("captures the actual tick, job drive, bootstrap and teardown without content or credentials", async () => {
		const created = await invoke("/api/sessions", "POST");
		expect(created.status).toBe(201);
		const sessionId: string = created.body.session.id; sessions.push(sessionId);
		const admitted = await invoke(`/api/sessions/${sessionId}/messages`, "POST", { prompt: "private-prompt" });
		expect(admitted.status).toBe(202);
		const submissionId: string = admitted.body.submission.id;
		const tick = await invoke("/api/worker", "POST", undefined, "private-worker-token");
		expect(tick.status).toBe(200);
		expect(tick.body.driven).toEqual([expect.objectContaining({ status: "completed", operationId: submissionId })]);
		const result = await invoke(`/api/submissions/${submissionId}/result`);
		expect(result.body.result.status).toBe("completed");
		expect(result.body.output.message.content[0].text).toBe("private-answer");

		const spans = capture.exporter.getFinishedSpans();
		const tickSpan = spans.find((span) => span.name === "worker.tick")!;
		const admissionSpan = spans.find((span) => span.name === "submission.admit")!;
		expect(admissionSpan.attributes).toMatchObject({ "agent.submission.id": submissionId, "agent.submission.created": true });
		expect(admissionSpan.spanContext().traceId).not.toBe(tickSpan.spanContext().traceId);
		const workerTrace = spans.filter((span) => span.spanContext().traceId === tickSpan.spanContext().traceId);
		for (const name of ["function.configure", "database.ready", "job.claim", "ownership.acquire", "ownership.close", "ownership.release", "function.close"]) {
			expect(workerTrace.some((span) => span.name === name), name).toBe(true);
		}
		for (const name of ["worker.admission.recover", "worker.discover", "worker.run", "worker.reconcile"]) {
			expect(workerTrace.find((span) => span.name === name)!.parentSpanContext?.spanId).toBe(tickSpan.spanContext().spanId);
		}
		expect(tickSpan.attributes).toMatchObject({ "agent.worker.phase": "complete", "agent.admission.processed.count": 0, "agent.admission.error.count": 0, "agent.discovered.count": 1, "agent.driven.count": 1, "agent.reconcile.error.count": 0 });
		const jobSpan = workerTrace.find((span) => span.name === "job.pass")!;
		expect(jobSpan.attributes).toMatchObject({ "agent.operation.id": submissionId, "agent.submission.id": submissionId, "agent.job.status": "completed", "agent.job.attempt": 1 });
		expect(jobSpan.attributes["agent.job.eligible_delay_ms"]).toBeGreaterThanOrEqual(0);
		expect(workerTrace.find((span) => span.name === "job.drive")!.parentSpanContext?.spanId).toBe(jobSpan.spanContext().spanId);
		expect(workerTrace.find((span) => span.name === "job.drive")!.attributes["agent.drive.outcome"]).toBe("settled");
		expect(workerTrace.find((span) => span.name === "function.request")!.attributes["http.response.status_code"]).toBe(200);
		const exported = JSON.stringify(spans.map((span) => ({ name: span.name, attributes: span.attributes, status: span.status, events: span.events })));
		expect(exported).not.toMatch(/private-prompt|private-answer|private-api-token|private-worker-token|private-retry-key|private-user|private-tenant/);
		expect(exported).not.toContain(databaseUrl);
	});

	it("traces unauthorized wakes without admitting or driving work", async () => {
		expect(await invoke("/api/worker?secret=private-query")).toMatchObject({ status: 401 });
		const spans = capture.exporter.getFinishedSpans();
		expect(spans.some((span) => span.name === "worker.tick" || span.name === "database.ready")).toBe(false);
		expect(spans.find((span) => span.name === "function.request")!.attributes).toMatchObject({ "http.route": "/api/worker", "http.response.status_code": 401 });
		expect(JSON.stringify(spans.map((span) => span.attributes))).not.toContain("private-query");
	});
});
