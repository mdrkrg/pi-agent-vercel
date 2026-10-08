import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/pi-agent-core/harness/context";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { SpanStatusCode } from "@opentelemetry/api";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { PostgresAdmission } from "../packages/agent-runtime/src/admission.ts";
import { DEFAULT_PASS_MS } from "../packages/agent-runtime/src/execution-budgets.ts";
import { FunctionService } from "../packages/agent-runtime/src/function-service.ts";
import { PostgresRecoveryCoordinator } from "../packages/agent-runtime/src/recovery.ts";
import { PostgresSubmissionReader } from "../packages/agent-runtime/src/submission-reader.ts";
import { PgExecutor } from "../packages/pi-postgres/src/index.ts";
import { captureTracing } from "./fixtures/tracing.ts";

const capture = captureTracing();
const privateData = "private-worker-tracing-error";
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); capture.exporter.reset(); });
afterAll(() => capture.close());

function fixture() {
	const models = createModels(); const faux = fauxProvider(); models.setProvider(faux.provider);
	const service = new FunctionService({ executor: new PgExecutor({ connectionString: "postgresql://unused/isolated-tracing-fixture" }), models, model: faux.getModel(), apiToken: "private-api", cronSecret: "private-worker", principal: { userId: "private-user", tenantId: "private-tenant", scopes: ["agent:run"] }, maxInvocationMs: 100 });
	let signal: AbortSignal;
	const admission = vi.spyOn(PostgresAdmission.prototype, "recoverPending").mockImplementation(async (context) => { signal = context.abortSignal!; return []; });
	const discover = vi.spyOn(PostgresRecoveryCoordinator.prototype, "discover").mockResolvedValue([]);
	const run = vi.spyOn(PostgresRecoveryCoordinator.prototype, "run").mockResolvedValue([]);
	const reconcile = vi.spyOn(PostgresSubmissionReader.prototype, "reconcilePending").mockResolvedValue([]);
	const untilAbort = () => new Promise<never>((_resolve, reject) => {
		if (signal.aborted) reject(signal.reason);
		else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
	});
	return { service, admission, discover, run, reconcile, untilAbort };
}

function exported() {
	return JSON.stringify(capture.exporter.getFinishedSpans().map((span) => ({ name: span.name, attributes: span.attributes, status: span.status, events: span.events })));
}

describe("worker progress tracing (no database or provider calls)", () => {
	it.each(["admission.recover", "discover", "run", "reconcile"] as const)("records the phase at the deadline during %s", async (phase) => {
		vi.useFakeTimers();
		const state = fixture();
		if (phase === "admission.recover") {
			const initial = state.admission.getMockImplementation()!;
			state.admission.mockImplementation(async (...args) => { await initial(...args); return state.untilAbort(); });
		} else state[phase].mockImplementation(state.untilAbort);
		try {
			const result = expect(state.service.worker.tick(BACKGROUND_CONTEXT)).rejects.toThrow("Function invocation budget exhausted");
			await vi.advanceTimersByTimeAsync(100);
			await result;
			const tick = capture.exporter.getFinishedSpans().find((span) => span.name === "worker.tick")!;
			expect(tick.attributes).toMatchObject({ "agent.invocation.exhausted": true, "agent.worker.deadline_phase": `worker.${phase}`, "agent.worker.phase": `worker.${phase}` });
			expect(tick.status.code).toBe(SpanStatusCode.ERROR);
		} finally { await state.service.close(); }
	});

	it("retains completed-stage counts and original errors when a later stage fails", async () => {
		const state = fixture();
		state.admission.mockResolvedValue([{ submissionId: "fixture", error: privateData }]);
		state.discover.mockResolvedValue([{} as Awaited<ReturnType<PostgresRecoveryCoordinator["discover"]>>[number]]);
		const failure = new Error(privateData);
		state.run.mockRejectedValue(failure);
		try {
			await expect(state.service.worker.tick(BACKGROUND_CONTEXT)).rejects.toBe(failure);
			const tick = capture.exporter.getFinishedSpans().find((span) => span.name === "worker.tick")!;
			expect(tick.attributes).toMatchObject({ "agent.worker.phase": "worker.run", "agent.admission.processed.count": 1, "agent.admission.error.count": 1, "agent.discovered.count": 1 });
			expect(tick.attributes["agent.pass.budget_ms"]).toBe(DEFAULT_PASS_MS);
			expect(tick.attributes["agent.invocation.exhausted"]).toBeUndefined();
			expect(tick.attributes["agent.driven.count"]).toBeUndefined();
			expect(exported()).not.toContain(privateData);
		} finally { await state.service.close(); }
	});

	it("does not label an upstream cancellation as its own invocation deadline", async () => {
		const state = fixture();
		state.discover.mockImplementation(state.untilAbort);
		const controller = new AbortController();
		const reason = new Error(privateData);
		try {
			const tick = state.service.worker.tick(withAbortSignal(controller.signal, BACKGROUND_CONTEXT));
			const rejected = expect(tick).rejects.toBe(reason);
			controller.abort(reason);
			await rejected;
			const span = capture.exporter.getFinishedSpans().find((item) => item.name === "worker.tick")!;
			expect(span.attributes["agent.invocation.exhausted"]).toBeUndefined();
			expect(span.attributes["agent.worker.deadline_phase"]).toBeUndefined();
			expect(exported()).not.toContain(privateData);
		} finally { await state.service.close(); }
	});
});
