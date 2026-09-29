import { randomUUID } from "node:crypto";
import type { SqlExecutor } from "./sql.ts";

export type SessionLease = {
	readonly sessionId: string;
	readonly holderId: string;
	readonly fencingEpoch: number;
	readonly expiresAt: Date;
};

export type SessionLeaseOptions = {
	readonly holderId?: string;
	readonly ttlMs?: number;
};

type LeaseRow = {
	holder_id: string;
	fencing_epoch: string | number;
	expires_at: Date | string;
};

type LeaseActiveRow = LeaseRow & { active: boolean };

const DEFAULT_TTL_MS = 90_000;

export class SessionLeaseBusyError extends Error {
	readonly name = "SessionLeaseBusyError";

	constructor(sessionId: string) {
		super(`Session lease is held by another owner: ${sessionId}`);
	}
}

export class SessionLeaseLostError extends Error {
	readonly name = "SessionLeaseLostError";

	constructor(sessionId: string) {
		super(`Session lease is no longer valid: ${sessionId}`);
	}
}

function integerValue(value: string | number): number {
	const result = typeof value === "number" ? value : Number(value);
	if (!Number.isSafeInteger(result)) throw new Error(`Unsafe PostgreSQL lease epoch: ${String(value)}`);
	return result;
}

function dateValue(value: Date | string): Date {
	const result = value instanceof Date ? new Date(value.getTime()) : new Date(value);
	if (Number.isNaN(result.getTime())) throw new Error(`Invalid PostgreSQL lease expiry: ${String(value)}`);
	return result;
}

function leaseFromRow(sessionId: string, row: LeaseRow): SessionLease {
	return {
		sessionId,
		holderId: row.holder_id,
		fencingEpoch: integerValue(row.fencing_epoch),
		expiresAt: dateValue(row.expires_at),
	};
}

function ttlValue(ttlMs: number): number {
	if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new Error(`Lease TTL must be a positive safe integer: ${ttlMs}`);
	return ttlMs;
}

/** Atomic session ownership with a monotonically increasing fencing epoch. */
export class SessionLeaseManager {
	constructor(private readonly executor: SqlExecutor) {}

	async acquire(sessionId: string, options: SessionLeaseOptions = {}): Promise<SessionLease> {
		const holderId = options.holderId ?? randomUUID();
		const ttlMs = ttlValue(options.ttlMs ?? DEFAULT_TTL_MS);
		const result = await this.executor.query<LeaseRow>(
			`INSERT INTO agent_session_leases (session_id, holder_id, fencing_epoch, expires_at)
			 VALUES ($1, $2, 1, now() + ($3::double precision * interval '1 millisecond'))
			 ON CONFLICT (session_id)
			 DO UPDATE SET
			   holder_id = EXCLUDED.holder_id,
			   fencing_epoch = agent_session_leases.fencing_epoch + 1,
			   expires_at = EXCLUDED.expires_at
			 WHERE agent_session_leases.expires_at <= now()
			 RETURNING holder_id, fencing_epoch, expires_at`,
			[sessionId, holderId, ttlMs],
		);
		const row = result.rows[0];
		if (row === undefined) throw new SessionLeaseBusyError(sessionId);
		return leaseFromRow(sessionId, row);
	}

	async renew(lease: SessionLease, ttlMs = DEFAULT_TTL_MS): Promise<SessionLease> {
		const result = await this.executor.query<LeaseRow>(
			`UPDATE agent_session_leases
			 SET expires_at = now() + ($4::double precision * interval '1 millisecond')
			 WHERE session_id = $1
			   AND holder_id = $2
			   AND fencing_epoch = $3
			   AND expires_at > now()
			 RETURNING holder_id, fencing_epoch, expires_at`,
			[lease.sessionId, lease.holderId, lease.fencingEpoch, ttlValue(ttlMs)],
		);
		const row = result.rows[0];
		if (row === undefined) throw new SessionLeaseLostError(lease.sessionId);
		return leaseFromRow(lease.sessionId, row);
	}

	async release(lease: SessionLease): Promise<void> {
		await this.executor.query(
			`DELETE FROM agent_session_leases
			 WHERE session_id = $1 AND holder_id = $2 AND fencing_epoch = $3`,
			[lease.sessionId, lease.holderId, lease.fencingEpoch],
		);
	}
}

/** Check ownership inside the caller's transaction so the row lock fences stale writers. */
export async function assertSessionLease(executor: SqlExecutor, lease: SessionLease): Promise<void> {
	const result = await executor.query<LeaseActiveRow>(
		`SELECT holder_id, fencing_epoch, expires_at, expires_at > now() AS active
		 FROM agent_session_leases
		 WHERE session_id = $1
		 FOR SHARE`,
		[lease.sessionId],
	);
	const row = result.rows[0];
	if (
		row === undefined
		|| row.holder_id !== lease.holderId
		|| integerValue(row.fencing_epoch) !== lease.fencingEpoch
		|| !row.active
	) {
		throw new SessionLeaseLostError(lease.sessionId);
	}
}
