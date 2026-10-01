import { randomUUID } from "node:crypto";
import type { SqlExecutor } from "./sql.ts";

export type DriveJobStatus = "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled";

export type DriveJob = {
	readonly id: string;
	readonly submissionId: string | null;
	readonly sessionId: string;
	readonly lane: string;
	readonly operationId: string;
	readonly status: DriveJobStatus;
	readonly attemptCount: number;
	readonly availableAt: number;
	readonly deferredHandle: unknown | null;
	readonly claimOwner: string | null;
	readonly claimEpoch: number;
	readonly claimExpiresAt: Date | null;
	readonly lastError: string | null;
	readonly createdAt: number;
	readonly updatedAt: number;
};

export type EnqueueDriveJob = {
	readonly id?: string;
	readonly submissionId?: string;
	readonly sessionId: string;
	readonly lane: string;
	readonly operationId: string;
	readonly availableAt?: number;
};

export type DriveJobClaim = {
	readonly ownerId: string;
	readonly ttlMs?: number;
	readonly limit?: number;
};

type Row = {
	id: string;
	submission_id: string | null;
	session_id: string;
	lane: string;
	operation_id: string;
	status: DriveJobStatus;
	attempt_count: number | string;
	available_at: number | string;
	deferred_handle: unknown;
	claim_owner: string | null;
	claim_epoch: number | string;
	claim_expires_at: Date | string | null;
	last_error: string | null;
	created_at: number | string;
	updated_at: number | string;
};

const COLUMNS = "id, submission_id, session_id, lane, operation_id, status, attempt_count, available_at, deferred_handle, claim_owner, claim_epoch, claim_expires_at, last_error, created_at, updated_at";

function integer(value: number | string, label: string): number {
	const result = typeof value === "number" ? value : Number(value);
	if (!Number.isSafeInteger(result)) throw new Error(`Unsafe drive job ${label}: ${String(value)}`);
	return result;
}

function date(value: Date | string | null): Date | null {
	if (value === null) return null;
	const result = value instanceof Date ? new Date(value.getTime()) : new Date(value);
	if (Number.isNaN(result.getTime())) throw new Error(`Invalid drive job claim expiry: ${String(value)}`);
	return result;
}

function fromRow(row: Row): DriveJob {
	return {
		id: row.id,
		submissionId: row.submission_id,
		sessionId: row.session_id,
		lane: row.lane,
		operationId: row.operation_id,
		status: row.status,
		attemptCount: integer(row.attempt_count, "attempt count"),
		availableAt: integer(row.available_at, "available time"),
		deferredHandle: row.deferred_handle ?? null,
		claimOwner: row.claim_owner,
		claimEpoch: integer(row.claim_epoch, "claim epoch"),
		claimExpiresAt: date(row.claim_expires_at),
		lastError: row.last_error,
		createdAt: integer(row.created_at, "created time"),
		updatedAt: integer(row.updated_at, "updated time"),
	};
}

function json(value: unknown): string {
	const encoded = JSON.stringify(value);
	if (encoded === undefined) throw new Error("Drive job deferred handle must be JSON serializable");
	return encoded;
}

function positiveInteger(value: number, label: string): number {
	if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe integer`);
	return value;
}

/** Durable queue and fencing record for one Pi operation drive pass. */
export class DriveJobRepo {
	constructor(private readonly executor: SqlExecutor, private readonly clock: () => number = Date.now) {}

	async enqueue(input: EnqueueDriveJob): Promise<DriveJob> {
		if ([input.sessionId, input.lane, input.operationId].some((value) => value.length === 0)) throw new Error("Drive job identity fields must not be empty");
		const now = this.clock();
		const availableAt = input.availableAt ?? now;
		if (!Number.isSafeInteger(availableAt)) throw new Error("Drive job availableAt must be a safe integer");
		const id = input.id ?? randomUUID();
		return this.executor.transaction(async (transaction) => {
			const inserted = await transaction.query<Row>(
				`INSERT INTO agent_drive_jobs (${COLUMNS}) VALUES ($1,$2,$3,$4,$5,'queued',0,$6,NULL,NULL,0,NULL,NULL,$7,$7)
				 ON CONFLICT (session_id, lane, operation_id) DO NOTHING RETURNING ${COLUMNS}`,
				[id, input.submissionId ?? null, input.sessionId, input.lane, input.operationId, availableAt, now],
			);
			if (inserted.rows[0] !== undefined) return fromRow(inserted.rows[0]);
			const existing = await transaction.query<Row>(`SELECT ${COLUMNS} FROM agent_drive_jobs WHERE session_id=$1 AND lane=$2 AND operation_id=$3 FOR SHARE`, [input.sessionId, input.lane, input.operationId]);
			if (existing.rows[0] === undefined) throw new Error("Drive job disappeared during idempotent enqueue");
			return fromRow(existing.rows[0]);
		});
	}

	async get(id: string): Promise<DriveJob | undefined> {
		const result = await this.executor.query<Row>(`SELECT ${COLUMNS} FROM agent_drive_jobs WHERE id=$1`, [id]);
		return result.rows[0] === undefined ? undefined : fromRow(result.rows[0]);
	}

	async listRecoverable(sessionId?: string, lane?: string): Promise<DriveJob[]> {
		const values: unknown[] = [];
		const predicates = ["status IN ('queued','waiting','running')"];
		if (sessionId !== undefined) { values.push(sessionId); predicates.push(`session_id=$${values.length}`); }
		if (lane !== undefined) { values.push(lane); predicates.push(`lane=$${values.length}`); }
		const result = await this.executor.query<Row>(`SELECT ${COLUMNS} FROM agent_drive_jobs WHERE ${predicates.join(" AND ")} ORDER BY available_at ASC, id ASC`, values);
		return result.rows.map(fromRow);
	}

	/** Claims due work with SKIP LOCKED and increments a fencing epoch atomically. */
	async claimDue(options: DriveJobClaim): Promise<DriveJob[]> {
		const ownerId = options.ownerId;
		if (ownerId.length === 0) throw new Error("Drive job ownerId must not be empty");
		const ttlMs = positiveInteger(options.ttlMs ?? 90_000, "Drive job claim TTL");
		const limit = positiveInteger(options.limit ?? 1, "Drive job claim limit");
		const now = this.clock();
		return this.executor.transaction(async (transaction) => {
			const result = await transaction.query<Row>(
				`WITH candidates AS (
					SELECT id FROM agent_drive_jobs
					WHERE ((status IN ('queued','waiting') AND available_at <= $1)
						OR (status='running' AND claim_expires_at <= now()))
					ORDER BY available_at ASC, id ASC
					FOR UPDATE SKIP LOCKED LIMIT $2
				)
				UPDATE agent_drive_jobs AS jobs
				SET status='running', attempt_count=jobs.attempt_count+1, claim_owner=$3,
					claim_epoch=jobs.claim_epoch+1, claim_expires_at=now()+($4::double precision * interval '1 millisecond'), updated_at=$1
				FROM candidates WHERE jobs.id=candidates.id
				RETURNING ${COLUMNS.split(", ").map((column) => `jobs.${column}`).join(", ")}`,
				[now, limit, ownerId, ttlMs],
			);
			return result.rows.map(fromRow);
		});
	}

	async complete(job: DriveJob, ownerId: string): Promise<DriveJob> {
		return this.updateClaim(job, ownerId, "completed", { availableAt: this.clock(), clearClaim: true });
	}

	async renew(job: DriveJob, ownerId: string, ttlMs = 90_000): Promise<void> {
		positiveInteger(ttlMs, "Drive job claim TTL");
		const result = await this.executor.query(`UPDATE agent_drive_jobs SET claim_expires_at=now()+($4::double precision * interval '1 millisecond') WHERE id=$1 AND status='running' AND claim_owner=$2 AND claim_epoch=$3 AND claim_expires_at > now()`, [job.id, ownerId, job.claimEpoch, ttlMs]);
		if (result.rowCount !== 1) throw new Error(`Drive job claim rejected: ${job.id}`);
	}

	async reschedule(job: DriveJob, ownerId: string, options: { availableAt: number; deferredHandle?: unknown; error?: string }): Promise<DriveJob> {
		if (!Number.isSafeInteger(options.availableAt)) throw new Error("Drive job availableAt must be a safe integer");
		return this.updateClaim(job, ownerId, "waiting", { availableAt: options.availableAt, deferredHandle: options.deferredHandle, ...(options.error === undefined ? {} : { error: options.error }), clearClaim: true });
	}

	async fail(job: DriveJob, ownerId: string, error: string): Promise<DriveJob> {
		return this.updateClaim(job, ownerId, "failed", { availableAt: this.clock(), error, clearClaim: true });
	}

	async release(job: DriveJob, ownerId: string, availableAt = this.clock()): Promise<DriveJob> {
		if (!Number.isSafeInteger(availableAt)) throw new Error("Drive job availableAt must be a safe integer");
		return this.updateClaim(job, ownerId, "queued", { availableAt, clearClaim: true });
	}

	private async updateClaim(job: DriveJob, ownerId: string, status: DriveJobStatus, options: { availableAt: number; deferredHandle?: unknown; error?: string; clearClaim: boolean }): Promise<DriveJob> {
		const values: unknown[] = [job.id, ownerId, job.claimEpoch, status, options.availableAt, this.clock()];
		const sets = ["status=$4", "available_at=$5", "updated_at=$6"];
		if (options.deferredHandle !== undefined) { values.push(json(options.deferredHandle)); sets.push(`deferred_handle=$${values.length}::jsonb`); }
		else sets.push("deferred_handle=NULL");
		if (options.error !== undefined) { values.push(options.error); sets.push(`last_error=$${values.length}`); }
		if (options.clearClaim) sets.push("claim_owner=NULL", "claim_expires_at=NULL");
		const result = await this.executor.query<Row>(`UPDATE agent_drive_jobs SET ${sets.join(", ")} WHERE id=$1 AND status='running' AND claim_owner=$2 AND claim_epoch=$3 AND claim_expires_at > now() RETURNING ${COLUMNS}`, values);
		if (result.rows[0] === undefined) throw new Error(`Drive job claim rejected: ${job.id}`);
		return fromRow(result.rows[0]);
	}
}
