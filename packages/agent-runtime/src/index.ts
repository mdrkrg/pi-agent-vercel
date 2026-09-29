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
