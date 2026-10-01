import type { Context } from "@earendil-works/pi-agent-core/harness/context";
import type { Entry, OperationResultRecord } from "@earendil-works/pi-agent-core/harness/session";
import { PostgresSessionRepo, SubmissionRepo, type Submission } from "@poc/pi-postgres";
import type { Principal } from "./ingress.ts";

export type SubmissionView = {
	readonly submission: Submission;
	readonly operation?: { readonly operationId: string; readonly lane: string; readonly status: "running" | "waiting" | "aborting" | OperationResultRecord["status"]; readonly retryAt?: number };
	readonly result?: OperationResultRecord;
};

/** Authorized reads and reconciliation share the same committed Pi snapshot. */
export class PostgresSubmissionReader {
	constructor(private readonly repo: PostgresSessionRepo, private readonly submissions: SubmissionRepo) {}

	async read(id: string, principal: Principal, context: Context): Promise<SubmissionView> {
		const submission = await this.submissions.get(id);
		if (submission === undefined || submission.userId !== principal.userId || submission.tenantId !== principal.tenantId) throw new Error("Submission not found");
		void context;
		return this.reconcile(submission);
	}

	async result(id: string, principal: Principal, context: Context): Promise<{ result: OperationResultRecord; output?: Entry }> {
		const view = await this.read(id, principal, context);
		if (view.result === undefined) throw new Error("Submission result is not complete");
		const output = view.result.tipId === null ? undefined : await this.repo.readEntry(view.submission.sessionId, view.result.tipId, context);
		return { result: view.result, ...(output === undefined ? {} : { output }) };
	}

	async reconcilePending(limit = 100, context?: Context): Promise<{ submissionId: string; error?: string }[]> {
		const results: { submissionId: string; error?: string }[] = [];
		for (const submission of await this.submissions.listUnsettled(limit)) {
			context?.abortSignal?.throwIfAborted();
			try { await this.reconcile(submission); results.push({ submissionId: submission.id }); }
			catch (error) { results.push({ submissionId: submission.id, error: error instanceof Error ? error.message : String(error) }); }
		}
		return results;
	}

	private async reconcile(submission: Submission, refreshed = false): Promise<SubmissionView> {
		if (submission.operationId === null) return { submission };
		const snapshot = await this.repo.readOperation(submission.sessionId, submission.operationId);
		// Pi removes operation metadata/state in the terminal result transaction.
		if (snapshot.meta !== undefined && snapshot.meta.lane !== submission.lane) throw new Error("Pi operation lane mismatch");
		const projected = await this.submissions.reconcileOperation(submission.id, snapshot.result, snapshot.state);
		if (snapshot.result === undefined && ["completed", "failed", "cancelled"].includes(projected.status)) {
			if (refreshed) throw new Error("Submission terminal projection disagrees with Pi");
			return this.reconcile(projected, true);
		}
		const retryAt = snapshot.state?.at === "assistant.retry_wait" || snapshot.state?.at === "summary.retry_wait" ? snapshot.state.notBefore : undefined;
		const status = snapshot.result?.status ?? (snapshot.state?.control.status === "cancel_requested" ? "aborting" : projected.status === "waiting" ? "waiting" : "running");
		return { submission: projected, operation: { operationId: submission.operationId, lane: submission.lane, status, ...(retryAt === undefined ? {} : { retryAt }) }, ...(snapshot.result === undefined ? {} : { result: snapshot.result }) };
	}
}
