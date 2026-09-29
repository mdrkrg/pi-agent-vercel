import {
	AgentHarness,
	type AgentHarness as AgentHarnessInstance,
	type AgentHarnessOptions,
	type AgentLane,
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
	let session: Awaited<ReturnType<PostgresSessionRepo["openWithLease"]>> | undefined;
	let harness: AgentHarnessInstance<TContext> | undefined;
	try {
		session = await repo.openWithLease(metadata, lease, context);
		const opened = await openAgentHarness({ ...harnessOptions, session }, context);
		harness = opened.harness;
		const lane = await harness.lane(laneName ?? "main", context);
		return await driveOperation(lane, operationId, context);
	} finally {
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
