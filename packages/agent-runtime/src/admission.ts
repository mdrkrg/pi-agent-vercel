import { AgentHarness, LaneBusy, type AgentHarnessOptions } from "@earendil-works/pi-agent-core";
import type { Context } from "@earendil-works/pi-agent-core/harness/context";
import { operationMeta, operationResult } from "@earendil-works/pi-agent-core/harness/session";
import { PostgresSessionRepo, SessionLeaseBusyError, SessionLeaseManager, SubmissionRepo, type SessionLeaseOptions, type Submission } from "@poc/pi-postgres";
import type { AuthenticatedRequest, SessionAuthorizer, SubmissionStart } from "./ingress.ts";

export type SubmissionHarnessOptions<TContext extends object | undefined> = Omit<AgentHarnessOptions<TContext>, "session">;
export type SubmissionHarnessFactory<TContext extends object | undefined> = (submission: Submission, context: Context) => SubmissionHarnessOptions<TContext> | Promise<SubmissionHarnessOptions<TContext>>;
export type PostgresAdmissionOptions<TContext extends object | undefined> = {
	readonly repo: PostgresSessionRepo;
	readonly submissions: SubmissionRepo;
	readonly leases: SessionLeaseManager;
	readonly harnessOptions: SubmissionHarnessFactory<TContext>;
	readonly lease?: SessionLeaseOptions;
	readonly lane?: string;
};

/** Persist input first; every recovery queries Pi before considering another accept. */
export class PostgresAdmission<TContext extends object | undefined = object | undefined> {
	constructor(private readonly options: PostgresAdmissionOptions<TContext>) {}

	async submit(request: AuthenticatedRequest, authorizer: SessionAuthorizer, context: Context): Promise<SubmissionStart> {
		await authorizer.authorize(request.principal, request.session, context);
		const created = await this.options.submissions.create({ ...request.principal, sessionId: request.session.id, clientRequestId: request.clientRequestId, prompt: request.prompt, lane: this.options.lane ?? "main" });
		return { submission: await this.recover(created.submission.id, context), created: created.created };
	}

	async recover(id: string, context: Context): Promise<Submission> {
		const submission = await this.options.submissions.get(id);
		if (submission === undefined) throw new Error(`Unknown submission: ${id}`);
		if (submission.operationId !== null || submission.status !== "accepted") return submission;
		const request = await this.options.submissions.getRequest(id);
		if (request === undefined) throw new Error(`Submission admission input unavailable: ${id}`);
		const metadata = (await this.options.repo.list(undefined, context)).find((session) => session.id === submission.sessionId);
		if (metadata === undefined) throw new Error(`Unknown session: ${submission.sessionId}`);
		let lease;
		try {
			lease = await this.options.leases.acquire(submission.sessionId, this.options.lease);
		} catch (error) {
			if (error instanceof SessionLeaseBusyError) return (await this.options.submissions.get(id))!;
			throw error;
		}
		let session: Awaited<ReturnType<PostgresSessionRepo["openWithLease"]>> | undefined;
		let harness: Awaited<ReturnType<typeof AgentHarness.create<TContext>>>["harness"] | undefined;
		try {
			// Another owner may have published between the first read and acquisition.
			const current = await this.options.submissions.get(id);
			if (current === undefined) throw new Error(`Unknown submission: ${id}`);
			if (current.operationId !== null || current.status !== "accepted") return current;
			session = await this.options.repo.openWithLease(metadata, lease, context);
			const meta = (await session.getValue(operationMeta(request.operationId), context))?.value;
			const result = (await session.getValue(operationResult(request.operationId), context))?.value;
			if (meta !== undefined && meta.lane !== request.lane) throw new Error("Admission operation lane mismatch");
			if (meta === undefined && result === undefined) {
				const opened = await AgentHarness.create({ ...await this.options.harnessOptions(current, context), session }, context);
				harness = opened.harness;
				const lane = await harness.lane(request.lane, context);
				const accepted = await lane.accept({ kind: "prompt", operationId: request.operationId, prompt: request.prompt }, context);
				if (!accepted.ok) {
					if (accepted.error instanceof LaneBusy) return current;
					throw accepted.error;
				}
			}
			return await this.options.submissions.attachOperationAndEnqueue(id, request.operationId, { sessionId: current.sessionId, lane: request.lane, lease });
		} finally {
			try {
				if (harness !== undefined) await harness.close(context);
			} finally {
				try { if (session !== undefined) await session.close(context); }
				finally { await this.options.leases.release(lease); }
			}
		}
	}

	async recoverPending(context: Context, limit = 100): Promise<{ submissionId: string; error?: string }[]> {
		const results: { submissionId: string; error?: string }[] = [];
		for (const submission of await this.options.submissions.listPending(limit)) {
			try { await this.recover(submission.id, context); results.push({ submissionId: submission.id }); }
			catch (error) { results.push({ submissionId: submission.id, error: error instanceof Error ? error.message : String(error) }); }
		}
		return results;
	}
}
