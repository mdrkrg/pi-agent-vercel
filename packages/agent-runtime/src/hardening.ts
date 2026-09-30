import type { WorkflowState } from "./scheduler.ts";
import type { Principal } from "./ingress.ts";

export type RuntimePolicy = {
	readonly leaseTtlMs: number;
	readonly driveTimeoutMs: number;
	readonly authorizationPolicyVersion: string;
	readonly retentionDays: number;
};

export type CredentialRequest = { readonly principal: Principal; readonly capability: string; readonly policyVersion: string };
export type CredentialLease = { readonly expiresAt: number; readonly value: string };
export interface CredentialBroker {
	issue(request: CredentialRequest): Promise<CredentialLease>;
}

export function requireScope(principal: Principal, scope: string): void {
	if (scope.length === 0 || !principal.scopes.includes(scope)) throw new Error(`Principal lacks required scope: ${scope}`);
}

export type RuntimeEvent = { readonly name: string; readonly attributes?: Record<string, unknown> };
export interface RuntimeObserver {
	record(event: RuntimeEvent): void;
}

export function recordRuntimeEvent(observer: RuntimeObserver | undefined, event: RuntimeEvent): void {
	if (observer === undefined) return;
	observer.record({ name: event.name, ...(event.attributes === undefined ? {} : { attributes: redactSecrets(event.attributes) as Record<string, unknown> }) });
}

export function validateRuntimePolicy(policy: RuntimePolicy): RuntimePolicy {
	if (!Number.isSafeInteger(policy.leaseTtlMs) || policy.leaseTtlMs < 1_000) throw new Error("leaseTtlMs must be at least one second");
	if (!Number.isSafeInteger(policy.driveTimeoutMs) || policy.driveTimeoutMs < 1_000) throw new Error("driveTimeoutMs must be at least one second");
	if (policy.authorizationPolicyVersion.length === 0) throw new Error("authorizationPolicyVersion is required");
	if (!Number.isSafeInteger(policy.retentionDays) || policy.retentionDays < 1) throw new Error("retentionDays must be positive");
	return policy;
}

export function workflowPayload(state: WorkflowState): WorkflowState {
	if (Object.keys(state).some((key) => !["submissionId", "sessionId", "operationId"].includes(key))) throw new Error("Workflow payload contains unsupported state");
	if (Object.values(state).some((value) => typeof value !== "string" || value.length === 0)) throw new Error("Workflow identities must be non-empty strings");
	return { submissionId: state.submissionId, sessionId: state.sessionId, operationId: state.operationId };
}

const SENSITIVE_KEY = /(?:authorization|bearer|credential|password|secret|token|api[-_]?key)/i;

/** Safe for logs and control-plane metadata; preserves shape while removing credentials. */
export function redactSecrets(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(redactSecrets);
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactSecrets(entry)]));
	}
	return value;
}
