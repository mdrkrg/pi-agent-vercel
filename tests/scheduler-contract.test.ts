import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core/harness/context";
import { describe, expect, it } from "vitest";
import { DriveScheduler, createFunctionHost, createSandboxHost, type WorkflowState } from "../packages/agent-runtime/src/index.ts";

const state: WorkflowState = { submissionId: "sub-1", sessionId: "session-1", operationId: "op-1" };

describe("drive scheduler contract", () => {
	it("carries identities and completes a settled drive", async () => {
		let received: WorkflowState | undefined;
		const host = createFunctionHost(async (value) => {
			received = value;
			return { ok: true, value: { kind: "settled", outcome: { operationId: "op-1", status: "completed" } } } as never;
		});
		const decision = await new DriveScheduler(host.drive).pass(state, BACKGROUND_CONTEXT);
		expect(received).toEqual(state);
		expect(decision).toEqual({ kind: "complete" });
	});

	it("turns Pi waiting outcomes into scheduler decisions", async () => {
		const decision = await new DriveScheduler(async () => ({
			ok: true,
			value: { kind: "waiting", operationId: "op-1", reason: "retry", notBefore: 50_000 },
		} as never), () => 1_000).pass(state, BACKGROUND_CONTEXT);
		expect(decision).toEqual({ kind: "retry", at: 50_000 });
	});

	it("retries drive errors and preserves deferred waits", async () => {
		const failed = await new DriveScheduler(async () => ({ ok: false, error: new Error("host terminated") } as never), () => 10_000).pass(state, BACKGROUND_CONTEXT);
		expect(failed).toEqual({ kind: "retry", at: 11_000 });
		const deferredHandle = { token: "deferred-1" };
		const waiting = await new DriveScheduler(async () => ({ ok: true, value: { kind: "waiting", operationId: "op-1", reason: "deferred", deferred: deferredHandle } } as never)).pass(state, BACKGROUND_CONTEXT);
		expect(waiting).toEqual({ kind: "wait", handle: deferredHandle });
	});

	it("keeps Function and Sandbox hosts on the same drive contract", async () => {
		const seen: WorkflowState[] = [];
		const drive = async (value: WorkflowState) => {
			seen.push(value);
			return { ok: true, value: { kind: "settled", outcome: { operationId: value.operationId, status: "completed" } } } as never;
		};
		expect(createFunctionHost(drive).kind).toBe("function");
		expect(createSandboxHost(drive).kind).toBe("sandbox");
		await createFunctionHost(drive).drive(state, BACKGROUND_CONTEXT);
		await createSandboxHost(drive).drive(state, BACKGROUND_CONTEXT);
		expect(seen).toEqual([state, state]);
		const request = { ...state, workload: { kind: "interactive" } as const };
		expect(await createFunctionHost(drive).execute(request, BACKGROUND_CONTEXT)).toEqual({ kind: "completed" });
		expect(await createSandboxHost(drive).execute(request, BACKGROUND_CONTEXT)).toEqual({ kind: "completed" });
		expect(await createFunctionHost(drive).execute({ ...state, workload: { kind: "heavy-compute", workspace: { localWorkspace: true, exec: true, expectedDuration: "long" } } }, BACKGROUND_CONTEXT)).toEqual({ kind: "failed" });
	});
});
