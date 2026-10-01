import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core/harness/context";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PostgresAdmission, openAgentHarness } from "../packages/agent-runtime/src/index.ts";
import { deletePiPostgresSession, DriveJobRepo, ensurePiPostgresSchema, PgExecutor, PostgresSessionRepo, SessionLeaseLostError, SessionLeaseManager, SubmissionRepo } from "../packages/pi-postgres/src/index.ts";

const databaseUrl = process.env.DATABASE_URL;
describe.skipIf(databaseUrl === undefined)("durable Postgres admission", () => {
	const executor = new PgExecutor({ connectionString: databaseUrl });
	const sessions: string[] = [];
	beforeAll(async () => ensurePiPostgresSchema(executor));
	afterEach(async () => { vi.restoreAllMocks(); for (const id of sessions.splice(0)) await deletePiPostgresSession(executor, id); });
	afterAll(async () => executor.close());

	async function setup() {
		const repo = new PostgresSessionRepo(executor);
		const session = await repo.create({ id: `admission-${randomUUID()}` }, BACKGROUND_CONTEXT);
		sessions.push(session.metadata.id);
		await session.close(BACKGROUND_CONTEXT);
		const models = createModels();
		const faux = fauxProvider(); models.setProvider(faux.provider);
		const harnessOptions = { models, model: faux.getModel() };
		const submissions = new SubmissionRepo(executor);
		const leases = new SessionLeaseManager(executor);
		const jobs = new DriveJobRepo(executor);
		const options = { repo, submissions, leases, harnessOptions: () => harnessOptions };
		const admission = new PostgresAdmission(options);
		const request = { principal: { userId: "u", tenantId: "t", scopes: [] }, session: session.metadata, clientRequestId: randomUUID(), prompt: "durable input" };
		return { repo, submissions, leases, jobs, options, admission, request, harnessOptions };
	}

	it("recovers input without a client retry and keeps only one Pi operation", async () => {
		const state = await setup();
		const created = await state.submissions.create({ ...state.request.principal, sessionId: state.request.session.id, clientRequestId: state.request.clientRequestId, prompt: state.request.prompt });
		const fresh = new PostgresAdmission({ ...state.options, repo: new PostgresSessionRepo(executor) });
		await fresh.recoverPending(BACKGROUND_CONTEXT);
		const admitted = await state.submissions.get(created.submission.id);
		expect(admitted).toMatchObject({ status: "running", operationId: created.submission.id });
		expect(await state.submissions.getRequest(created.submission.id)).toBeUndefined();
		const retried = await state.admission.submit(state.request, { authorize: async () => undefined }, BACKGROUND_CONTEXT);
		expect(retried.submission.operationId).toBe(created.submission.id);
		expect(await state.jobs.listRecoverable(state.request.session.id)).toHaveLength(1);
		await state.repo.close(BACKGROUND_CONTEXT);
	});

	it("repairs a crash after Pi accept and attaches a job inserted by discovery", async () => {
		const state = await setup();
		vi.spyOn(state.submissions, "attachOperationAndEnqueue").mockRejectedValueOnce(new Error("crash before publication"));
		await expect(state.admission.submit(state.request, { authorize: async () => undefined }, BACKGROUND_CONTEXT)).rejects.toThrow("crash before publication");
		const [pending] = await state.submissions.listPending();
		expect(pending).toBeDefined();
		await state.jobs.enqueue({ sessionId: pending!.sessionId, lane: "main", operationId: pending!.id });
		await new PostgresAdmission({ ...state.options, repo: new PostgresSessionRepo(executor) }).recoverPending(BACKGROUND_CONTEXT);
		expect(await state.jobs.listRecoverable(pending!.sessionId)).toEqual([expect.objectContaining({ operationId: pending!.id, submissionId: pending!.id })]);
		const session = await state.repo.open(state.request.session, BACKGROUND_CONTEXT);
		const opened = await openAgentHarness({ ...state.harnessOptions, session }, BACKGROUND_CONTEXT);
		const lane = await opened.harness.lane("main", BACKGROUND_CONTEXT);
		expect((await lane.findEntries(undefined, BACKGROUND_CONTEXT)).length).toBe(1);
		expect(opened.open.map((operation) => operation.operationId)).toEqual([pending!.id]);
		await opened.harness.close(BACKGROUND_CONTEXT); await state.repo.close(BACKGROUND_CONTEXT);
	});

	it("serializes duplicate submissions using session ownership and rejects lane changes", async () => {
		const state = await setup();
		const other = new PostgresAdmission({ ...state.options, repo: new PostgresSessionRepo(executor) });
		const results = await Promise.all([state.admission, other].map((admission) => admission.submit(state.request, { authorize: async () => undefined }, BACKGROUND_CONTEXT)));
		expect(results[0]!.submission.id).toBe(results[1]!.submission.id);
		await other.recoverPending(BACKGROUND_CONTEXT);
		expect(await state.jobs.listRecoverable(state.request.session.id)).toHaveLength(1);
		await expect(state.submissions.create({ ...state.request.principal, sessionId: state.request.session.id, clientRequestId: state.request.clientRequestId, prompt: state.request.prompt, lane: "other" })).rejects.toThrow("different lane");
		await state.repo.close(BACKGROUND_CONTEXT);
	});

	it("rolls back publication under a lost session lease", async () => {
		const state = await setup();
		const created = await state.submissions.create({ ...state.request.principal, sessionId: state.request.session.id, clientRequestId: state.request.clientRequestId, prompt: state.request.prompt });
		const lease = await state.leases.acquire(state.request.session.id);
		await state.leases.release(lease);
		await expect(state.submissions.attachOperationAndEnqueue(created.submission.id, created.submission.id, { sessionId: state.request.session.id, lane: "main", lease })).rejects.toBeInstanceOf(SessionLeaseLostError);
		expect(await state.submissions.get(created.submission.id)).toMatchObject({ operationId: null, status: "accepted" });
		expect(await state.submissions.getRequest(created.submission.id)).toMatchObject({ prompt: state.request.prompt });
		expect(await state.jobs.listRecoverable(state.request.session.id)).toEqual([]);
		await state.repo.close(BACKGROUND_CONTEXT);
	});
});
