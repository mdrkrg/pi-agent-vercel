import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core/harness/context";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PostgresAdmission, PostgresRecoveryCoordinator, PostgresSubmissionReader, openAgentHarness } from "../packages/agent-runtime/src/index.ts";
import { deletePiPostgresSession, DriveJobRepo, ensurePiPostgresSchema, PgExecutor, PostgresSessionRepo, SessionLeaseManager, SubmissionRepo } from "../packages/pi-postgres/src/index.ts";

const databaseUrl = process.env.DATABASE_URL;
describe.skipIf(databaseUrl === undefined)("authoritative Pi submission results", () => {
	const executor = new PgExecutor({ connectionString: databaseUrl }); const sessions: string[] = [];
	beforeAll(async () => ensurePiPostgresSchema(executor));
	afterEach(async () => { vi.restoreAllMocks(); for (const id of sessions.splice(0)) await deletePiPostgresSession(executor, id); });
	afterAll(async () => executor.close());
	async function setup(fail = false) {
		const repo = new PostgresSessionRepo(executor); const session = await repo.create({ id: `result-${randomUUID()}` }, BACKGROUND_CONTEXT);
		sessions.push(session.metadata.id); await session.close(BACKGROUND_CONTEXT);
		const models = createModels(); const faux = fauxProvider(); models.setProvider(faux.provider);
		faux.setResponses([fauxAssistantMessage(fail ? "failed response" : "final answer", fail ? { stopReason: "error", errorMessage: "test failure" } : {})]);
		const options = { models, model: faux.getModel(), retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 } };
		const submissions = new SubmissionRepo(executor); const leases = new SessionLeaseManager(executor); const jobs = new DriveJobRepo(executor);
		const principal = { userId: "u", tenantId: "t", scopes: [] };
		const admission = new PostgresAdmission({ repo, submissions, leases, harnessOptions: () => options });
		const submitted = await admission.submit({ principal, session: session.metadata, clientRequestId: randomUUID(), prompt: "hello" }, { authorize: async () => undefined }, BACKGROUND_CONTEXT);
		const worker = new PostgresRecoveryCoordinator({ ...options, repo, leases, jobs, workerId: "worker", context: BACKGROUND_CONTEXT });
		const reader = new PostgresSubmissionReader(repo, submissions);
		return { repo, submissions, leases, jobs, principal, submission: submitted.submission, worker, reader, metadata: session.metadata, options };
	}

	it("repairs a missed projection update and keeps the result tied to its frozen tip", async () => {
		const state = await setup(); const id = state.submission.id;
		const stale = await state.repo.readOperation(state.metadata.id, id);
		await state.worker.run();
		expect(await state.submissions.get(id)).toMatchObject({ status: "running" });
		const failedProjection = vi.spyOn(state.submissions, "reconcileOperation").mockRejectedValueOnce(new Error("projection unavailable"));
		await expect(state.reader.read(id, state.principal, BACKGROUND_CONTEXT)).rejects.toThrow("projection unavailable");
		failedProjection.mockRestore();
		const view = await state.reader.read(id, state.principal, BACKGROUND_CONTEXT);
		expect(view).toMatchObject({ submission: { status: "completed", resultRef: `pi.result:${id}` }, result: { status: "completed" } });
		const before = await state.reader.result(id, state.principal, BACKGROUND_CONTEXT);
		await state.submissions.reconcileOperation(id, undefined, stale.state);
		expect(await state.submissions.get(id)).toMatchObject({ status: "completed" });
		const session = await state.repo.open(state.metadata, BACKGROUND_CONTEXT);
		const opened = await openAgentHarness({ ...state.options, session }, BACKGROUND_CONTEXT);
		const lane = await opened.harness.lane("main", BACKGROUND_CONTEXT);
		await lane.appendMessage({ role: "user", content: "later message", timestamp: Date.now() }, BACKGROUND_CONTEXT);
		await opened.harness.close(BACKGROUND_CONTEXT);
		expect(await state.reader.result(id, state.principal, BACKGROUND_CONTEXT)).toEqual(before);
		expect(before.output).toMatchObject({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "final answer" }] } });
		await expect(state.reader.result(id, { ...state.principal, tenantId: "other" }, BACKGROUND_CONTEXT)).rejects.toThrow("Submission not found");
		await state.repo.close(BACKGROUND_CONTEXT);
	});

	it("projects a failed Pi outcome even though its drive job completed", async () => {
		const state = await setup(true);
		expect(await state.worker.run()).toEqual([expect.objectContaining({ status: "completed" })]);
		const view = await state.reader.read(state.submission.id, state.principal, BACKGROUND_CONTEXT);
		expect(view).toMatchObject({ submission: { status: "failed" }, result: { status: "failed" } });
		await state.repo.close(BACKGROUND_CONTEXT);
	});

	it("projects cancellation only after Pi settles its durable abort request", async () => {
		const state = await setup();
		const lease = await state.leases.acquire(state.metadata.id);
		const session = await state.repo.openWithLease(state.metadata, lease, BACKGROUND_CONTEXT);
		const opened = await openAgentHarness({ ...state.options, session }, BACKGROUND_CONTEXT);
		const lane = await opened.harness.lane("main", BACKGROUND_CONTEXT);
		await lane.requestAbort(state.submission.id, BACKGROUND_CONTEXT);
		await opened.harness.close(BACKGROUND_CONTEXT); await state.leases.release(lease);
		expect(await state.reader.read(state.submission.id, state.principal, BACKGROUND_CONTEXT)).toMatchObject({ submission: { status: "running" }, operation: { status: "aborting" } });
		await state.worker.run(); await state.reader.reconcilePending();
		expect(await state.reader.result(state.submission.id, state.principal, BACKGROUND_CONTEXT)).toMatchObject({ result: { status: "aborted" } });
		expect(await state.submissions.get(state.submission.id)).toMatchObject({ status: "cancelled" });
		await state.repo.close(BACKGROUND_CONTEXT);
	});
});
