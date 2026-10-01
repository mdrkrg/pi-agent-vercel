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
export { DriveScheduler, FunctionExecutionHost, SandboxExecutionHost, createFunctionHost, createSandboxHost, type AgentExecutionRequest, type AgentExecutionResult, type AgentWorkloadClass, type DriveHost, type ExecutionHost, type SchedulerDecision, type WorkspaceRequirement, type WorkflowState } from "./scheduler.ts";
export { admitSubmission, readFinalResult, readSubmission, type AdmissionOptions, type AuthenticatedRequest, type FinalResultReader, type OperationAcceptor, type OperationRecovery, type Principal, type SessionAuthorizer, type SubmissionStore, type WorkflowStarter } from "./ingress.ts";
export { recordRuntimeEvent, redactSecrets, requireScope, validateRuntimePolicy, workflowPayload, type CredentialBroker, type CredentialLease, type CredentialRequest, type RuntimeEvent, type RuntimeObserver, type RuntimePolicy } from "./hardening.ts";
export { MemoryWorkspace, type AgentWorkspace, type Command, type CommandResult, type ComputeEnvironment, type ObjectStoreReference, type WorkspaceEntry, type WorkspacePath } from "./workspace.ts";
export { PostgresRecoveryCoordinator, type RecoveryCoordinatorOptions, type RecoveryPassResult } from "./recovery.ts";
export { PostgresAdmission, type PostgresAdmissionOptions, type SubmissionHarnessFactory, type SubmissionHarnessOptions } from "./admission.ts";

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
};

export async function drivePostgresOperation<TContext extends object | undefined>(
	options: PostgresDriveOptions<TContext>,
	operationId: string,
	context: Context,
): Promise<DriveResult> {
	const { repo, leases, session: metadata, lease: leaseOptions, lane: laneName, ...harnessOptions } = options;
	const lease = await leases.acquire(metadata.id, leaseOptions);
	const renewalPeriod = Math.max(1_000, Math.floor((leaseOptions?.ttlMs ?? 90_000) / 3));
	const renewalTimer = setInterval(() => {
		void leases.renew(lease, leaseOptions?.ttlMs).catch(() => undefined);
	}, renewalPeriod);
	renewalTimer.unref?.();
	let session: Awaited<ReturnType<PostgresSessionRepo["openWithLease"]>> | undefined;
	let harness: AgentHarnessInstance<TContext> | undefined;
	try {
		session = await repo.openWithLease(metadata, lease, context);
		const opened = await openAgentHarness({ ...harnessOptions, session }, context);
		harness = opened.harness;
		const lane = await harness.lane(laneName ?? "main", context);
		return await driveOperation(lane, operationId, context);
	} finally {
		clearInterval(renewalTimer);
		try {
			if (harness !== undefined) await harness.close(context);
		} finally {
			try {
				if (session !== undefined) await session.close(context);
			} finally {
				await leases.release(lease);
			}
		}
	}
}
