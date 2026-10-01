import {
	AgentHarness,
	type AgentHarness as AgentHarnessInstance,
	type AgentHarnessOptions,
	type AgentLane,
	type AbortRequestResult,
	type DriveResult,
	type OpenOperation,
	type OperationAdmissionResult,
} from "@earendil-works/pi-agent-core";
import type { Context } from "@earendil-works/pi-agent-core/harness/context";
import type { SessionMetadata } from "@earendil-works/pi-agent-core/harness/session";
import {
	PostgresSessionRepo,
	SessionLeaseManager,
	type SessionLeaseOptions,
} from "@poc/pi-postgres";
import { withSessionOwnership } from "./ownership.ts";
export { DriveScheduler, FunctionExecutionHost, SandboxExecutionHost, createFunctionHost, createSandboxHost, type AgentExecutionRequest, type AgentExecutionResult, type AgentWorkloadClass, type DriveHost, type ExecutionHost, type SchedulerDecision, type WorkspaceRequirement, type WorkflowState } from "./scheduler.ts";
export { admitSubmission, readFinalResult, readSubmission, type AdmissionOptions, type AuthenticatedRequest, type FinalResultReader, type OperationAcceptor, type OperationRecovery, type Principal, type SessionAuthorizer, type SubmissionStore, type WorkflowStarter } from "./ingress.ts";
export { recordRuntimeEvent, redactSecrets, requireScope, validateRuntimePolicy, workflowPayload, type CredentialBroker, type CredentialLease, type CredentialRequest, type RuntimeEvent, type RuntimeObserver, type RuntimePolicy } from "./hardening.ts";
export { MemoryWorkspace, type AgentWorkspace, type Command, type CommandResult, type ComputeEnvironment, type ObjectStoreReference, type WorkspaceEntry, type WorkspacePath } from "./workspace.ts";
export { PostgresRecoveryCoordinator, type RecoveryCoordinatorOptions, type RecoveryPassResult } from "./recovery.ts";
export { PostgresAdmission, type PostgresAdmissionOptions, type SubmissionHarnessFactory, type SubmissionHarnessOptions } from "./admission.ts";
export { DriveDeadlineExceeded, withSessionOwnership, type OwnedSession } from "./ownership.ts";

export interface OpenAgentHarnessResult<TContext extends object | undefined> {
	readonly harness: AgentHarnessInstance<TContext>;
	readonly open: OpenOperation[];
}

export async function openAgentHarness<TContext extends object | undefined>(
	options: AgentHarnessOptions<TContext>,
	context: Context,
): Promise<OpenAgentHarnessResult<TContext>> {
	return AgentHarness.create(options, context);
}

export function acceptPrompt(
	lane: AgentLane,
	prompt: string,
	context: Context,
): Promise<OperationAdmissionResult> {
	return lane.accept({ kind: "prompt", prompt }, context);
}

export function driveOperation(
	lane: AgentLane,
	operationId: string,
	context: Context,
): Promise<DriveResult> {
	return lane.drive({ operationId, waitForRetry: false, pollDeferred: false }, context);
}

export function requestOperationAbort(lane: AgentLane, operationId: string, context: Context): Promise<AbortRequestResult> {
	return lane.requestAbort(operationId, context);
}

export type PostgresDriveOptions<TContext extends object | undefined> = Omit<AgentHarnessOptions<TContext>, "session"> & {
	readonly repo: PostgresSessionRepo;
	readonly leases: SessionLeaseManager;
	readonly session: SessionMetadata;
	readonly lease?: SessionLeaseOptions;
	readonly lane?: string;
	readonly maxPassMs?: number;
};

export async function drivePostgresOperation<TContext extends object | undefined>(
	options: PostgresDriveOptions<TContext>,
	operationId: string,
	context: Context,
): Promise<DriveResult> {
	const { repo, leases, session: metadata, lease: leaseOptions, lane: laneName, maxPassMs, ...harnessOptions } = options;
	return withSessionOwnership({ sessionId: metadata.id, leases, ...(leaseOptions === undefined ? {} : { lease: leaseOptions }), ...(maxPassMs === undefined ? {} : { maxDurationMs: maxPassMs }) }, context, async (owned) => {
		const session = await repo.openWithLease(metadata, owned.lease, owned.context);
		owned.registerSession(session);
		const opened = await openAgentHarness({ ...harnessOptions, session }, owned.context);
		owned.registerHarness(opened.harness);
		const lane = await opened.harness.lane(laneName ?? "main", owned.context);
		return driveOperation(lane, operationId, owned.context);
	});
}
