import { withAbortSignal, withoutAbortSignal, type Context } from "@earendil-works/pi-agent-core/harness/context";
import type { Session } from "@earendil-works/pi-agent-core/harness/session";
import { SessionLeaseLostError, SessionLeaseManager, type SessionLease, type SessionLeaseOptions } from "@poc/pi-postgres";

export class DriveDeadlineExceeded extends Error {
	readonly name = "DriveDeadlineExceeded";
	constructor() { super("Function drive pass exceeded its execution budget"); }
}

type ClosableHarness = { close(context: Context): Promise<void> };
export type OwnedSession = {
	readonly lease: SessionLease;
	readonly context: Context;
	registerSession(session: Session): void;
	registerHarness(harness: ClosableHarness): void;
	assertActive(): void;
};

/** Own one bounded pass. Closing Pi seals its gate; aborting only its observer does not. */
export async function withSessionOwnership<T>(
	options: { sessionId: string; leases: SessionLeaseManager; lease?: SessionLeaseOptions; maxDurationMs?: number; renewAdditional?: () => Promise<void> },
	context: Context,
	run: (owned: OwnedSession) => Promise<T>,
): Promise<T> {
	const ttlMs = options.lease?.ttlMs ?? 90_000;
	const budgetMs = options.maxDurationMs ?? 45_000;
	if (!Number.isSafeInteger(budgetMs) || budgetMs <= 0) throw new Error("Execution budget must be a positive safe integer");
	context.abortSignal?.throwIfAborted();
	const lease = await options.leases.acquire(options.sessionId, options.lease);
	const controller = new AbortController();
	const ownedContext = withAbortSignal(controller.signal, context);
	const cleanupContext = withoutAbortSignal(context);
	let active = true;
	let session: Session | undefined;
	let harness: ClosableHarness | undefined;
	let closing: Promise<void> | undefined;
	let renewalTimer: ReturnType<typeof setTimeout> | undefined;
	let expiryTimer: ReturnType<typeof setTimeout> | undefined;
	let renewing: Promise<void> | undefined;
	const close = () => {
		closing ??= harness !== undefined ? harness.close(cleanupContext) : session?.close(cleanupContext) ?? Promise.resolve();
		void closing.catch(() => undefined);
	};
	const stop = (reason: unknown) => {
		if (!active) return;
		controller.abort(reason);
		close();
	};
	const assertActive = () => controller.signal.throwIfAborted();
	const parentAbort = () => stop(context.abortSignal?.reason);
	context.abortSignal?.addEventListener("abort", parentAbort, { once: true });
	if (context.abortSignal?.aborted) parentAbort();
	const budgetTimer = setTimeout(() => stop(new DriveDeadlineExceeded()), budgetMs);
	const armExpiry = (expiresAt: Date) => {
		if (expiryTimer !== undefined) clearTimeout(expiryTimer);
		expiryTimer = setTimeout(() => stop(new SessionLeaseLostError(options.sessionId)), Math.max(1, expiresAt.getTime() - Date.now()));
	};
	const scheduleRenewal = () => {
		renewalTimer = setTimeout(() => {
			if (!active || controller.signal.aborted) return;
			renewing = (async () => {
				try {
					const renewed = await options.leases.renew(lease, ttlMs);
					if (options.renewAdditional !== undefined) await options.renewAdditional();
					if (active && !controller.signal.aborted) { armExpiry(renewed.expiresAt); scheduleRenewal(); }
				} catch (error) { stop(error); }
			})();
		}, Math.max(1, Math.floor(ttlMs / 3)));
	};
	armExpiry(lease.expiresAt);
	scheduleRenewal();
	try {
		assertActive();
		const result = await run({
			lease, context: ownedContext, assertActive,
			registerSession(value) { session = value; if (controller.signal.aborted) { closing = undefined; close(); } assertActive(); },
			registerHarness(value) { harness = value; if (controller.signal.aborted) { closing = undefined; close(); } assertActive(); },
		});
		assertActive();
		return result;
	} finally {
		active = false;
		clearTimeout(budgetTimer);
		if (renewalTimer !== undefined) clearTimeout(renewalTimer);
		if (expiryTimer !== undefined) clearTimeout(expiryTimer);
		context.abortSignal?.removeEventListener("abort", parentAbort);
		close();
		try { await closing; }
		finally {
			try { await renewing; }
			finally { await options.leases.release(lease); }
		}
	}
}
