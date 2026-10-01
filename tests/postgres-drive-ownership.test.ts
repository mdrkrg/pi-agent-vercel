import { randomUUID } from "node:crypto";
import type { AgentHarnessTool } from "@earendil-works/pi-agent-core";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core/harness/context";
import { operationState } from "@earendil-works/pi-agent-core/harness/session";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PostgresAdmission, PostgresRecoveryCoordinator } from "../packages/agent-runtime/src/index.ts";
import { deletePiPostgresSession, DriveJobRepo, ensurePiPostgresSchema, PgExecutor, PostgresSessionRepo, SessionLeaseLostError, SessionLeaseManager, SubmissionRepo } from "../packages/pi-postgres/src/index.ts";

const databaseUrl = process.env.DATABASE_URL;
describe.skipIf(databaseUrl === undefined)("drive ownership and Function budget", () => {
	const executor = new PgExecutor({ connectionString: databaseUrl, query_timeout: 3_000 });
	const sessions: string[] = [];
	beforeAll(async () => ensurePiPostgresSchema(executor));
	afterEach(async () => { vi.restoreAllMocks(); for (const id of sessions.splice(0)) await deletePiPostgresSession(executor, id); });
	afterAll(async () => executor.close());

	async function setup(execute: AgentHarnessTool<undefined>["execute"], maxPassMs = 2_000) {
		const repo = new PostgresSessionRepo(executor);
		const session = await repo.create({ id: `ownership-${randomUUID()}` }, BACKGROUND_CONTEXT);
		sessions.push(session.metadata.id); await session.close(BACKGROUND_CONTEXT);
		const models = createModels(); const faux = fauxProvider(); models.setProvider(faux.provider);
		faux.setResponses([fauxAssistantMessage(fauxToolCall("effect", {}, { id: "call" })), fauxAssistantMessage("done")]);
		const tool: AgentHarnessTool<undefined> = { name: "effect", label: "Effect", description: "Effect", parameters: { type: "object", properties: {} }, replay: "never", execute };
		const harnessOptions = { models, model: faux.getModel(), tools: [tool], toolContext: undefined };
		const leases = new SessionLeaseManager(executor); const jobs = new DriveJobRepo(executor); const submissions = new SubmissionRepo(executor);
		const admission = new PostgresAdmission({ repo, leases, submissions, harnessOptions: () => harnessOptions });
		const admitted = await admission.submit({ principal: { userId: "u", tenantId: "t", scopes: [] }, session: session.metadata, clientRequestId: randomUUID(), prompt: "effect" }, { authorize: async () => undefined }, BACKGROUND_CONTEXT);
		const worker = new PostgresRecoveryCoordinator({ ...harnessOptions, repo, leases, jobs, workerId: "worker", context: BACKGROUND_CONTEXT, lease: { ttlMs: 300 }, maxPassMs });
		return { repo, leases, jobs, worker, submission: admitted.submission, metadata: session.metadata };
	}

	it("renews both ownership records through a tool longer than their TTL", async () => {
		const state = await setup(async () => {
			await new Promise((resolve) => setTimeout(resolve, 700));
			return { content: [{ type: "text", text: "effect settled" }], details: undefined };
		});
		const renewSession = vi.spyOn(state.leases, "renew"); const renewJob = vi.spyOn(state.jobs, "renew");
		expect(await state.worker.run()).toEqual([expect.objectContaining({ status: "completed" })]);
		expect(renewSession.mock.calls.length).toBeGreaterThan(1); expect(renewJob.mock.calls.length).toBeGreaterThan(1);
		expect(await state.jobs.listRecoverable(state.metadata.id)).toEqual([]);
		await state.repo.close(BACKGROUND_CONTEXT);
	});

	it.each(["session", "job", "deadline"] as const)("stops the live effect on %s loss without cancelling durable work", async (failure) => {
		let started = 0; let aborted = 0;
		const state = await setup(async (_id, _args, _update, _toolContext, _invocation, context) => {
			started++;
			await new Promise<void>((_resolve, reject) => {
				context.abortSignal!.addEventListener("abort", () => { aborted++; reject(context.abortSignal!.reason); }, { once: true });
			});
			throw new Error("unreachable");
		}, failure === "deadline" ? 250 : 2_000);
		if (failure === "session") vi.spyOn(state.leases, "renew").mockRejectedValueOnce(new SessionLeaseLostError(state.metadata.id));
		if (failure === "job") vi.spyOn(state.jobs, "renew").mockRejectedValueOnce(new Error("claim lost"));
		expect(await state.worker.run()).toEqual([expect.objectContaining({ status: "waiting" })]);
		expect(started).toBe(1); expect(aborted).toBe(1);
		const session = await state.repo.open(state.metadata, BACKGROUND_CONTEXT);
		const stored = await session.getValue(operationState(state.submission.operationId!), BACKGROUND_CONTEXT);
		expect(stored?.value).toMatchObject({ at: "tools", control: { status: "running" } });
		await session.close(BACKGROUND_CONTEXT);
		await state.repo.close(BACKGROUND_CONTEXT);
	});

	it("rejects an expired job claim before a replacement worker arrives", async () => {
		const jobs = new DriveJobRepo(executor);
		const sessionId = `claim-${randomUUID()}`; sessions.push(sessionId);
		await jobs.enqueue({ sessionId, lane: "main", operationId: "operation" });
		const [claim] = await jobs.claimDue({ ownerId: "old-worker" });
		await executor.query("UPDATE agent_drive_jobs SET claim_expires_at=now()-interval '1 second' WHERE id=$1", [claim!.id]);
		await expect(jobs.renew(claim!, "old-worker")).rejects.toThrow("claim rejected");
		await expect(jobs.complete(claim!, "old-worker")).rejects.toThrow("claim rejected");
		const [replacement] = await jobs.claimDue({ ownerId: "new-worker" });
		expect(replacement!.claimEpoch).toBe(claim!.claimEpoch + 1);
	});
});
