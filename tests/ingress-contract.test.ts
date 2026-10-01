import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core/harness/context";
import type { SessionMetadata } from "@earendil-works/pi-agent-core/harness/session";
import { describe, expect, it } from "vitest";
import { admitSubmission, readFinalResult, readSubmission, type Principal, type SubmissionStore } from "../packages/agent-runtime/src/index.ts";
import type { Submission } from "../packages/pi-postgres/src/index.ts";

const session: SessionMetadata = { id: "s-1", createdAt: 1, storageVersion: 1 };
const principal: Principal = { userId: "u-1", tenantId: "t-1", scopes: ["agent:write"] };

function store(completeOnAttach = false): SubmissionStore {
	const rows = new Map<string, Submission>();
	return {
		async create(input) {
			const existing = [...rows.values()].find((row) => row.userId === input.userId && row.tenantId === input.tenantId && row.sessionId === input.sessionId && row.clientRequestId === input.clientRequestId);
			if (existing !== undefined) return { submission: existing, created: false };
			const now = input.now ?? 1;
			const submission: Submission = { id: `sub-${rows.size + 1}`, userId: input.userId, tenantId: input.tenantId, sessionId: input.sessionId, clientRequestId: input.clientRequestId, requestHash: "test-hash", lane: input.lane ?? "main", operationId: null, status: "accepted", resultRef: null, errorCode: null, createdAt: now, updatedAt: now };
			rows.set(submission.id, submission); return { submission, created: true };
		},
		async get(id) { return rows.get(id); },
		async withAdmissionLock(id, callback) {
			const row = rows.get(id); if (row === undefined) throw new Error("missing");
			return callback(row);
		},
		async attachOperation(id, operationId) {
			const row = rows.get(id); if (row === undefined) throw new Error("missing");
			const next = { ...row, operationId, status: completeOnAttach ? "completed" as const : "running" as const }; rows.set(id, next); return next;
		},
	};
}

describe("ingress contract", () => {
	it("authorizes, admits once, and converges retries", async () => {
		const repo = store(); let accepts = 0;
		const request = { principal, session, clientRequestId: "req-1", prompt: "hello" };
		const authorizer = { authorize: async () => undefined };
		const first = await admitSubmission(request, authorizer, repo, async () => `op-${++accepts}`, BACKGROUND_CONTEXT);
		const second = await admitSubmission(request, authorizer, repo, async () => `op-${++accepts}`, BACKGROUND_CONTEXT);
		expect(first.submission.id).toBe(second.submission.id);
		expect(first.submission.operationId).toBe("op-1");
		expect(second.submission.operationId).toBe("op-1");
		expect(accepts).toBe(1);
	});

	it("authoritative reads enforce tenant ownership", async () => {
		const repo = store();
		const result = await admitSubmission({ principal, session, clientRequestId: "req-2", prompt: "hello" }, { authorize: async () => undefined }, repo, async () => "op-2", BACKGROUND_CONTEXT);
		await expect(readSubmission(repo, result.submission.id, { ...principal, userId: "other" }, BACKGROUND_CONTEXT)).rejects.toThrow("Submission not found");
	});

	it("starts workflow with identities only", async () => {
		const repo = store();
		let workflow: { submissionId: string; sessionId: string; operationId: string } | undefined;
		await admitSubmission({ principal, session, clientRequestId: "req-3", prompt: "hello" }, { authorize: async () => undefined }, repo, async () => "op-3", BACKGROUND_CONTEXT, async (state) => { workflow = state; });
		expect(workflow).toEqual({ submissionId: "sub-1", sessionId: "s-1", operationId: "op-3" });
	});

	it("reconciles an accepted operation and publishes its durable drive identity", async () => {
		const repo = store();
		let accepts = 0;
		let enqueued: { submissionId: string; operationId: string; sessionId: string; lane: string } | undefined;
		const admitted = await admitSubmission(
			{ principal, session, clientRequestId: "req-recover", prompt: "hello" },
			{ authorize: async () => undefined },
			repo,
			async () => `fresh-${++accepts}`,
			BACKGROUND_CONTEXT,
			undefined,
			{
				recoverOperation: async () => "recovered-op",
				enqueueDriveJob: async (job) => { enqueued = job; },
			},
		);
		expect(accepts).toBe(0);
		expect(admitted.submission.operationId).toBe("recovered-op");
		expect(enqueued).toEqual({ submissionId: "sub-1", operationId: "recovered-op", sessionId: "s-1", lane: "main" });
	});

	it("reads the final result through durable state after authorization", async () => {
		const repo = store(true);
		const admitted = await admitSubmission({ principal, session, clientRequestId: "req-4", prompt: "hello" }, { authorize: async () => undefined }, repo, async () => "op-4", BACKGROUND_CONTEXT);
		await expect(readFinalResult(repo, admitted.submission.id, principal, BACKGROUND_CONTEXT, async (submission) => `answer:${submission.operationId}`)).resolves.toBe("answer:op-4");
	});

	it("retries drive publication after the operation identity was attached", async () => {
		const repo = store();
		const request = { principal, session, clientRequestId: "req-publish-retry", prompt: "hello" };
		let accepts = 0;
		let publications = 0;
		const options = {
			enqueueDriveJob: async (job: { operationId: string }) => {
				expect(job.operationId).toBe("publish-operation");
				if (++publications === 1) throw new Error("queue unavailable");
			},
		};
		const accept = async () => { accepts++; return "publish-operation"; };
		await expect(admitSubmission(request, { authorize: async () => undefined }, repo, accept, BACKGROUND_CONTEXT, undefined, options)).rejects.toThrow("queue unavailable");
		const retried = await admitSubmission(request, { authorize: async () => undefined }, repo, accept, BACKGROUND_CONTEXT, undefined, options);
		expect(retried.submission.operationId).toBe("publish-operation");
		expect(accepts).toBe(1);
		expect(publications).toBe(2);
	});
});
