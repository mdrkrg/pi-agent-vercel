import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core/harness/context";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { acceptPrompt, openAgentHarness, PostgresRecoveryCoordinator } from "../packages/agent-runtime/src/index.ts";
import { deletePiPostgresSession, DriveJobRepo, ensurePiPostgresSchema, PgExecutor, PostgresSessionRepo, SessionLeaseManager } from "../packages/pi-postgres/src/index.ts";

const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(databaseUrl === undefined)("Postgres recovery coordinator", () => {
	const executor = new PgExecutor({ connectionString: databaseUrl });
	const sessions: string[] = [];
	beforeAll(async () => ensurePiPostgresSchema(executor));
	afterEach(async () => {
		for (const sessionId of sessions.splice(0)) await deletePiPostgresSession(executor, sessionId);
	});
	afterAll(async () => executor.close());

	async function acceptedOperation() {
		const models = createModels();
		const faux = fauxProvider();
		models.setProvider(faux.provider);
		faux.setResponses([fauxAssistantMessage("recovered")]);
		const model = faux.getModel();
		const sessionId = `coordinator-${randomUUID()}`;
		sessions.push(sessionId);
		const repo = new PostgresSessionRepo(executor);
		const leases = new SessionLeaseManager(executor);
		const lease = await leases.acquire(sessionId);
		const session = await repo.createWithLease({ id: sessionId }, lease, BACKGROUND_CONTEXT);
		const opened = await openAgentHarness({ session, models, model }, BACKGROUND_CONTEXT);
		const lane = await opened.harness.lane("main", BACKGROUND_CONTEXT);
		const admission = await acceptPrompt(lane, "resume without a caller-provided operation id", BACKGROUND_CONTEXT);
		if (!admission.ok) throw admission.error;
		await opened.harness.close(BACKGROUND_CONTEXT);
		await session.close(BACKGROUND_CONTEXT);
		await repo.close(BACKGROUND_CONTEXT);
		await leases.release(lease);
		return { metadata: session.metadata, operationId: admission.value.operationId, models, model, leases };
	}

	it("discovers and completes an accepted operation with a fresh repository", async () => {
		const accepted = await acceptedOperation();
		const repo = new PostgresSessionRepo(executor);
		const jobs = new DriveJobRepo(executor);
		const worker = new PostgresRecoveryCoordinator({ ...accepted, repo, jobs, workerId: "fresh-worker", context: BACKGROUND_CONTEXT });
		try {
			const [job] = await worker.discover([accepted.metadata.id]);
			expect(job?.operationId).toBe(accepted.operationId);
			expect(await worker.discover([accepted.metadata.id])).toEqual([job]);
			expect(await worker.run()).toEqual([expect.objectContaining({ status: "completed", operationId: accepted.operationId })]);
			expect(await worker.discover([accepted.metadata.id])).toEqual([]);
			expect(await jobs.get(job!.id)).toMatchObject({ status: "completed" });
		} finally {
			await repo.close(BACKGROUND_CONTEXT);
		}
	});

	it("keeps open work recoverable after a transient worker exception", async () => {
		const accepted = await acceptedOperation();
		const repo = new PostgresSessionRepo(executor);
		let now = Date.now();
		const jobs = new DriveJobRepo(executor, () => now);
		const job = await jobs.enqueue({ sessionId: accepted.metadata.id, lane: "main", operationId: accepted.operationId });
		let reads = 0;
		const worker = new PostgresRecoveryCoordinator({
			...accepted, repo, jobs, workerId: "retry-worker", context: BACKGROUND_CONTEXT, now: () => now,
			sessionMetadata: async () => {
				if (++reads === 1) throw new Error("temporary metadata outage");
				return accepted.metadata;
			},
		});
		try {
			expect(await worker.run()).toEqual([expect.objectContaining({ status: "waiting" })]);
			expect(await jobs.get(job.id)).toMatchObject({ status: "waiting", lastError: "Error: temporary metadata outage" });
			now += 1_000;
			expect(await worker.run()).toEqual([expect.objectContaining({ status: "completed", operationId: accepted.operationId })]);
		} finally {
			await repo.close(BACKGROUND_CONTEXT);
		}
	});
});
