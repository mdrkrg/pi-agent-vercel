import { describe, expect, it } from "vitest";
import { redactSecrets, requireScope, validateRuntimePolicy, workflowPayload } from "../packages/agent-runtime/src/index.ts";

describe("runtime hardening contracts", () => {
	it("accepts only bounded policy values", () => {
		expect(validateRuntimePolicy({ leaseTtlMs: 30_000, driveTimeoutMs: 60_000, authorizationPolicyVersion: "v3", retentionDays: 30 }).authorizationPolicyVersion).toBe("v3");
		expect(() => validateRuntimePolicy({ leaseTtlMs: 1, driveTimeoutMs: 60_000, authorizationPolicyVersion: "v3", retentionDays: 30 })).toThrow();
	});

	it("keeps workflow payload to durable identities and redacts credentials", () => {
		expect(workflowPayload({ submissionId: "s", sessionId: "se", operationId: "o" })).toEqual({ submissionId: "s", sessionId: "se", operationId: "o" });
		expect(redactSecrets({ userId: "u", authorization: "Bearer x", nested: { apiKey: "secret" } })).toEqual({ userId: "u", authorization: "[REDACTED]", nested: { apiKey: "[REDACTED]" } });
	});

	it("models credentials as short-lived broker output", async () => {
		let requestVersion = "";
		const broker = { issue: async (request: { policyVersion: string }) => { requestVersion = request.policyVersion; return { expiresAt: Date.now() + 1_000, value: "ephemeral" }; } };
		const lease = await broker.issue({ policyVersion: "v3" });
		expect(requestVersion).toBe("v3");
		expect(lease.value).toBe("ephemeral");
	});

	it("enforces tool scopes on reconstructed principals", () => {
		const principal = { userId: "u", tenantId: "t", scopes: ["read:data"] };
		requireScope(principal, "read:data");
		expect(() => requireScope(principal, "write:data")).toThrow("write:data");
	});

	it("redacts event attributes before observability sinks receive them", async () => {
		const events: unknown[] = [];
		const { recordRuntimeEvent } = await import("../packages/agent-runtime/src/index.ts");
		recordRuntimeEvent({ record: (event) => events.push(event) }, { name: "tool.completed", attributes: { token: "secret", operationId: "op-1" } });
		expect(events).toEqual([{ name: "tool.completed", attributes: { token: "[REDACTED]", operationId: "op-1" } }]);
	});
});
