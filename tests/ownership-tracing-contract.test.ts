import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core/harness/context";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DriveDeadlineExceeded, withSessionOwnership } from "../packages/agent-runtime/src/ownership.ts";
import type { SessionLease, SessionLeaseManager } from "../packages/pi-postgres/src/index.ts";
import { captureTracing } from "./fixtures/tracing.ts";

let capture: ReturnType<typeof captureTracing> | undefined;
beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
	try {
		// The memory exporter completes exports on zero-delay timers.
		await vi.advanceTimersByTimeAsync(1);
		await capture?.close();
		expect(vi.getTimerCount()).toBe(0);
	}
	finally { capture = undefined; vi.useRealTimers(); }
});

function fixture(failedSpan: string) {
	const onStart = vi.fn((span: { name: string }) => { if (span.name === failedSpan) throw new Error("private-processor-error"); });
	capture = captureTracing([{ onStart, onEnd() {}, async forceFlush() {}, async shutdown() {} }]);
	const lease: SessionLease = { sessionId: "fixture", holderId: "holder", fencingEpoch: 1, expiresAt: new Date(Date.now() + 90_000) };
	const events: string[] = [];
	const close = vi.fn(async () => { events.push("close"); });
	const acquire = vi.fn(async () => lease);
	const renew = vi.fn(async () => ({ ...lease, expiresAt: new Date(Date.now() + 90_000) }));
	const release = vi.fn(async () => { events.push("release"); });
	const leases = { acquire, renew, release } as unknown as SessionLeaseManager;
	return { onStart, events, close, renew, release, options: { sessionId: lease.sessionId, leases } };
}

it.each(["ownership.close", "ownership.release"])("preserves execution errors and cleanup order when %s onStart throws", async (failedSpan) => {
	const state = fixture(failedSpan);
	const original = new Error("original-execution-error");
	await expect(withSessionOwnership(state.options, BACKGROUND_CONTEXT, async (owned) => {
		owned.registerHarness({ close: state.close });
		throw original;
	})).rejects.toBe(original);
	expect(state.onStart.mock.calls.some(([span]) => span.name === failedSpan)).toBe(true);
	expect(state.close).toHaveBeenCalledOnce();
	expect(state.release).toHaveBeenCalledOnce();
	expect(state.events).toEqual(["close", "release"]);
});

it("still releases ownership after a cleanup error when its release span cannot start", async () => {
	const state = fixture("ownership.release");
	const cleanupError = new Error("original-cleanup-error");
	state.close.mockRejectedValueOnce(cleanupError);
	await expect(withSessionOwnership(state.options, BACKGROUND_CONTEXT, async (owned) => {
		owned.registerHarness({ close: state.close });
	})).rejects.toBe(cleanupError);
	expect(state.close).toHaveBeenCalledOnce();
	expect(state.release).toHaveBeenCalledOnce();
});

it("closes the effect gate at a deadline even when ownership.close onStart throws", async () => {
	const state = fixture("ownership.close");
	const pass = withSessionOwnership({ ...state.options, maxDurationMs: 100 }, BACKGROUND_CONTEXT, async (owned) => {
		owned.registerHarness({ close: state.close });
		await new Promise<void>((resolve) => owned.context.abortSignal!.addEventListener("abort", () => { state.events.push("abort"); resolve(); }, { once: true }));
	});
	const rejected = expect(pass).rejects.toBeInstanceOf(DriveDeadlineExceeded);
	await vi.advanceTimersByTimeAsync(100);
	await rejected;
	expect(state.close).toHaveBeenCalledOnce();
	expect(state.release).toHaveBeenCalledOnce();
	expect(state.events).toEqual(["abort", "close", "release"]);
});

it("renews both claims when their telemetry span cannot start", async () => {
	const state = fixture("ownership.renew");
	const renewAdditional = vi.fn(async () => undefined);
	const pass = withSessionOwnership({ ...state.options, maxDurationMs: 200, lease: { ttlMs: 300 }, renewAdditional }, BACKGROUND_CONTEXT, async (owned) => {
		owned.registerHarness({ close: state.close });
		await new Promise<void>((resolve) => owned.context.abortSignal!.addEventListener("abort", () => resolve(), { once: true }));
	});
	const rejected = expect(pass).rejects.toBeInstanceOf(DriveDeadlineExceeded);
	await vi.advanceTimersByTimeAsync(200);
	await rejected;
	expect(state.renew).toHaveBeenCalledOnce();
	expect(renewAdditional).toHaveBeenCalledOnce();
	expect(state.close).toHaveBeenCalledOnce();
	expect(state.release).toHaveBeenCalledOnce();
});
