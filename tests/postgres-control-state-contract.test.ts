import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DelegatedTaskRepo, ensurePiPostgresSchema, purgeSubmissionControlState, PgExecutor, SubmissionRepo } from "../packages/pi-postgres/src/index.ts";
import { admitSubmission } from "../packages/agent-runtime/src/index.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core/harness/context";

const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(databaseUrl === undefined)("Postgres control-state contracts", () => {
	const executor = new PgExecutor({ connectionString: databaseUrl });
	const sessionId = `control-${randomUUID()}`;

	beforeAll(async () => ensurePiPostgresSchema(executor));
	afterAll(async () => {
		await executor.query("DELETE FROM agent_delegated_tasks WHERE parent_submission_id IN (SELECT id FROM agent_submissions WHERE session_id = $1)", [sessionId]);
		await executor.query("DELETE FROM agent_submissions WHERE session_id = $1", [sessionId]);
		await executor.close();
	});

	it("deduplicates a client retry and preserves the operation identity", async () => {
		const repo = new SubmissionRepo(executor, () => 100);
		const input = { userId: "u", tenantId: "t", sessionId, clientRequestId: "request-1", prompt: "hello" };
		const first = await repo.create(input);
		const retry = await repo.create(input);
		expect(first.created).toBe(true);
		expect(retry.created).toBe(false);
		expect(retry.submission.id).toBe(first.submission.id);
		await expect(repo.create({ ...input, prompt: "changed" })).rejects.toThrow("different prompt");
		const running = await repo.attachOperation(first.submission.id, "operation-1");
		const replay = await repo.create(input);
		expect(running.operationId).toBe("operation-1");
		expect(replay.submission.operationId).toBe("operation-1");
		expect((await repo.attachOperation(first.submission.id, "different-operation")).operationId).toBe("operation-1");
		await repo.transition(first.submission.id, ["running"], { status: "completed", resultRef: "result-1" });
	});

	it("serializes concurrent operation admission for one client request", async () => {
		const repo = new SubmissionRepo(executor, () => 300);
		let accepted = 0;
		const request = { principal: { userId: "u", tenantId: "t", scopes: [] }, session: { id: sessionId, createdAt: 1, storageVersion: 1 }, clientRequestId: `concurrent-${randomUUID()}`, prompt: "hello" };
		const authorize = { authorize: async () => undefined };
		const accept = async () => { accepted++; await new Promise((resolve) => setTimeout(resolve, 20)); return "operation-concurrent"; };
		const [first, second] = await Promise.all([
			admitSubmission(request, authorize, repo, accept, BACKGROUND_CONTEXT),
			admitSubmission(request, authorize, repo, accept, BACKGROUND_CONTEXT),
		]);
		expect(first.submission.id).toBe(second.submission.id);
		expect(first.submission.operationId).toBe("operation-concurrent");
		expect(second.submission.operationId).toBe("operation-concurrent");
		expect(accepted).toBe(1);
	});

	it("deduplicates delegated work and enforces lifecycle transitions", async () => {
		const repo = new DelegatedTaskRepo(executor, () => 200);
		const parent = await new SubmissionRepo(executor, () => 190).create({ userId: "u", tenantId: "t", sessionId, clientRequestId: `parent-${randomUUID()}`, prompt: "parent" });
		const input = { parentSubmissionId: parent.submission.id, idempotencyKey: "task-1", userId: "u", tenantId: "t" };
		await expect(repo.create({ ...input, userId: "other" })).rejects.toThrow("authorization mismatch");
		const first = await repo.create(input);
		const retry = await repo.create(input);
		expect(retry.id).toBe(first.id);
		const running = await repo.transition(first.id, ["accepted"], "running", { checkpointRef: "checkpoint-1" });
		const waiting = await repo.transition(running.id, ["running"], "waiting", { checkpointRef: "checkpoint-2" });
		const resumed = await repo.transition(waiting.id, ["waiting"], "running");
		const completed = await repo.transition(resumed.id, ["running"], "completed", { artifactRef: "artifact-1" });
		expect(completed.status).toBe("completed");
		expect(completed.artifactRef).toBe("artifact-1");
		await expect(repo.transition(completed.id, ["completed"], "running")).rejects.toThrow("Invalid task transition");
		expect(await repo.getAuthorized(completed.id, "u", "t")).toMatchObject({ id: completed.id });
		expect(await repo.getAuthorized(completed.id, "other", "t")).toBeUndefined();
	});

	it("retains active state and purges only terminal control records", async () => {
		const oldRepo = new SubmissionRepo(executor, () => 10);
		const old = await oldRepo.create({ userId: "u", tenantId: "t", sessionId, clientRequestId: `retention-${randomUUID()}`, prompt: "old" });
		await oldRepo.attachOperation(old.submission.id, "retention-operation");
		await oldRepo.transition(old.submission.id, ["running"], { status: "completed", resultRef: "artifact" });
		const purged = await purgeSubmissionControlState(executor, 100);
		expect(purged).toBeGreaterThanOrEqual(1);
		expect(await oldRepo.get(old.submission.id)).toBeUndefined();
	});
});
