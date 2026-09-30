import type { Context } from "@earendil-works/pi-agent-core/harness/context";
import type { DriveResult } from "@earendil-works/pi-agent-core";

export type WorkflowState = { readonly submissionId: string; readonly sessionId: string; readonly operationId: string };
export type WorkspaceRequirement = { readonly localWorkspace: boolean; readonly exec: boolean; readonly expectedDuration: "short" | "long" };
export type AgentWorkloadClass =
	| { readonly kind: "interactive" }
	| { readonly kind: "background" }
	| { readonly kind: "heavy-compute"; readonly workspace: WorkspaceRequirement };
export type AgentExecutionRequest = WorkflowState & { readonly workload: AgentWorkloadClass };
export type AgentExecutionResult =
	| { readonly kind: "completed" }
	| { readonly kind: "waiting"; readonly notBefore?: number; readonly handle?: unknown }
	| { readonly kind: "failed"; readonly retryAt?: number };
export type SchedulerDecision =
	| { readonly kind: "complete" }
	| { readonly kind: "retry"; readonly at: number }
	| { readonly kind: "wait"; readonly handle: unknown };

export type DriveHost = (state: WorkflowState, context: Context) => Promise<DriveResult>;

/** The workflow boundary carries identities only; Pi remains the source of operation semantics. */
export class DriveScheduler {
	constructor(private readonly drive: DriveHost, private readonly now: () => number = Date.now) {}

	async pass(state: WorkflowState, context: Context): Promise<SchedulerDecision> {
		const result = await this.drive(state, context);
		if (!result.ok) return { kind: "retry", at: this.now() + 1_000 };
		if (result.value.kind === "settled") return { kind: "complete" };
		if (result.value.reason === "retry") return { kind: "retry", at: Math.max(this.now(), result.value.notBefore) };
		return { kind: "wait", handle: result.value.deferred };
	}
}

export interface ExecutionHost {
	readonly kind: "function" | "sandbox";
		drive(state: WorkflowState, context: Context): Promise<DriveResult>;
	execute(request: AgentExecutionRequest, context: Context): Promise<AgentExecutionResult>;
}

function hostResult(result: DriveResult): AgentExecutionResult {
	if (!result.ok) return { kind: "failed", retryAt: Date.now() + 1_000 };
	if (result.value.kind === "settled") return { kind: "completed" };
	if (result.value.reason === "retry") return { kind: "waiting", notBefore: result.value.notBefore };
	return { kind: "waiting", handle: result.value.deferred };
}

abstract class BaseExecutionHost implements ExecutionHost {
	abstract readonly kind: "function" | "sandbox";
	constructor(readonly drive: DriveHost) {}
	async execute(request: AgentExecutionRequest, context: Context): Promise<AgentExecutionResult> {
		return hostResult(await this.drive(request, context));
	}
}

/** Host selection is an optimization. Both hosts receive the same durable identities. */
export class FunctionExecutionHost extends BaseExecutionHost {
	readonly kind = "function" as const;
	async execute(request: AgentExecutionRequest, context: Context): Promise<AgentExecutionResult> {
		if (request.workload.kind === "heavy-compute") return { kind: "failed" };
		return super.execute(request, context);
	}
}

export class SandboxExecutionHost extends BaseExecutionHost {
	readonly kind = "sandbox" as const;
}

export function createFunctionHost(drive: DriveHost): FunctionExecutionHost {
	return new FunctionExecutionHost(drive);
}

export function createSandboxHost(drive: DriveHost): SandboxExecutionHost {
	return new SandboxExecutionHost(drive);
}
