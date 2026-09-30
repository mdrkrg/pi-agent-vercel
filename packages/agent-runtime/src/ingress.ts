import type { Context } from "@earendil-works/pi-agent-core/harness/context";
import type { SessionMetadata } from "@earendil-works/pi-agent-core/harness/session";
import type { Submission, SubmissionRepo } from "@poc/pi-postgres";

export type Principal = { readonly userId: string; readonly tenantId: string; readonly scopes: readonly string[] };
export type AuthenticatedRequest = { readonly principal: Principal; readonly session: SessionMetadata; readonly clientRequestId: string; readonly prompt: string };
export type SubmissionStart = { readonly submission: Submission; readonly created: boolean };

export interface SessionAuthorizer {
	authorize(principal: Principal, session: SessionMetadata, context: Context): Promise<void>;
}

export type OperationAcceptor = (submission: Submission, prompt: string, context: Context) => Promise<string>;
export type SubmissionStore = Pick<SubmissionRepo, "create" | "get" | "attachOperation"> & {
	withAdmissionLock?: SubmissionRepo["withAdmissionLock"];
};
export type WorkflowStarter = (state: { submissionId: string; sessionId: string; operationId: string }, context: Context) => Promise<void>;
export type FinalResultReader<T> = (submission: Submission, context: Context) => Promise<T>;

/** Authentication and session authorization stay at ingress; durable Pi execution starts after admission. */
export async function admitSubmission(
	request: AuthenticatedRequest,
	authorizer: SessionAuthorizer,
	repo: SubmissionStore,
	accept: OperationAcceptor,
	context: Context,
	startWorkflow?: WorkflowStarter,
): Promise<SubmissionStart> {
	await authorizer.authorize(request.principal, request.session, context);
	const created = await repo.create({
		userId: request.principal.userId,
		tenantId: request.principal.tenantId,
		sessionId: request.session.id,
		clientRequestId: request.clientRequestId,
		prompt: request.prompt,
	});
	// A retry may observe an accepted row after a process died before it could
	// publish the Pi operation identity. Re-run admission for that same durable
	// submission; once the identity is present, all retries converge on it.
	const admit = async (locked: Submission): Promise<Submission> => {
		let submission = locked;
		if (submission.operationId === null) {
			const operationId = await accept(submission, request.prompt, context);
			submission = await repo.attachOperation(submission.id, operationId);
		}
		if (startWorkflow !== undefined && submission.operationId !== null) {
			await startWorkflow({ submissionId: submission.id, sessionId: submission.sessionId, operationId: submission.operationId }, context);
		}
		return submission;
	};
	return {
		submission: repo.withAdmissionLock === undefined ? await admit(created.submission) : await repo.withAdmissionLock(created.submission.id, admit),
		created: created.created,
	};
}

export async function readSubmission(repo: SubmissionStore, id: string, principal: Principal, context: Context): Promise<Submission> {
	const submission = await repo.get(id);
	if (submission === undefined || submission.userId !== principal.userId || submission.tenantId !== principal.tenantId) throw new Error("Submission not found");
	void context;
	return submission;
}

/** Reads the committed Pi result through a caller-provided durable session reader. */
export async function readFinalResult<T>(repo: SubmissionStore, id: string, principal: Principal, context: Context, read: FinalResultReader<T>): Promise<T> {
	const submission = await readSubmission(repo, id, principal, context);
	if (submission.status !== "completed" || submission.operationId === null) throw new Error("Submission result is not complete");
	return read(submission, context);
}
