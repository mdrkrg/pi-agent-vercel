import type { Context } from "@earendil-works/pi-agent-core/harness/context";
import type { SessionMetadata } from "@earendil-works/pi-agent-core/harness/session";
import type { AdmissionDriveJob, Submission, SubmissionRepo } from "@poc/pi-postgres";

export type Principal = { readonly userId: string; readonly tenantId: string; readonly scopes: readonly string[] };
export type AuthenticatedRequest = { readonly principal: Principal; readonly session: SessionMetadata; readonly clientRequestId: string; readonly prompt: string };
export type SubmissionStart = { readonly submission: Submission; readonly created: boolean };

export interface SessionAuthorizer {
	authorize(principal: Principal, session: SessionMetadata, context: Context): Promise<void>;
}

export type OperationAcceptor = (submission: Submission, prompt: string, context: Context) => Promise<string>;
export type SubmissionStore = Pick<SubmissionRepo, "create" | "get" | "attachOperation"> & {
	withAdmissionLock?: SubmissionRepo["withAdmissionLock"];
	attachOperationAndEnqueue?: SubmissionRepo["attachOperationAndEnqueue"];
};
export type WorkflowStarter = (state: { submissionId: string; sessionId: string; operationId: string }, context: Context) => Promise<void>;
export type FinalResultReader<T> = (submission: Submission, context: Context) => Promise<T>;
export type OperationRecovery = (submission: Submission, context: Context) => Promise<string | undefined>;
export type AdmissionOptions = {
	readonly lane?: string;
	readonly recoverOperation?: OperationRecovery;
	readonly enqueueDriveJob?: (job: AdmissionDriveJob & { submissionId: string; operationId: string }) => Promise<void>;
};

/** Authentication and session authorization stay at ingress; durable Pi execution starts after admission. */
export async function admitSubmission(
	request: AuthenticatedRequest,
	authorizer: SessionAuthorizer,
	repo: SubmissionStore,
	accept: OperationAcceptor,
	context: Context,
	startWorkflow?: WorkflowStarter,
	options: AdmissionOptions = {},
): Promise<SubmissionStart> {
	await authorizer.authorize(request.principal, request.session, context);
	const created = await repo.create({
		userId: request.principal.userId,
		tenantId: request.principal.tenantId,
		sessionId: request.session.id,
		clientRequestId: request.clientRequestId,
		prompt: request.prompt,
		lane: options.lane ?? "main",
	});
	// A retry may observe an accepted row after a process died before it could
	// publish the Pi operation identity. Re-run admission for that same durable
	// submission; once the identity is present, all retries converge on it.
	const admit = async (locked: Submission): Promise<Submission> => {
		let submission = locked;
		if (submission.operationId === null) {
			const recovered = options.recoverOperation === undefined ? undefined : await options.recoverOperation(submission, context);
			const operationId = recovered ?? await accept(submission, request.prompt, context);
			if (repo.attachOperationAndEnqueue !== undefined && options.enqueueDriveJob === undefined) {
				submission = await repo.attachOperationAndEnqueue(submission.id, operationId, { sessionId: submission.sessionId, lane: options.lane ?? "main" });
			} else {
				submission = await repo.attachOperation(submission.id, operationId);
			}
		}
		// A custom publisher may have failed after attachment. Retry publication
		// using the attached identity; the publisher must enqueue idempotently.
		if (options.enqueueDriveJob !== undefined && submission.operationId !== null && (submission.status === "running" || submission.status === "waiting")) {
			await options.enqueueDriveJob({ submissionId: submission.id, operationId: submission.operationId, sessionId: submission.sessionId, lane: options.lane ?? "main" });
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
