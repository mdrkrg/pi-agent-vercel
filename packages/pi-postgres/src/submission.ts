import { createHash, randomUUID } from "node:crypto";
import type { SqlExecutor } from "./sql.ts";
import { assertSessionLease, type SessionLease } from "./lease.ts";

export type SubmissionStatus = "accepted" | "running" | "waiting" | "completed" | "failed" | "cancelled";

export type Submission = {
	readonly id: string;
	readonly userId: string;
	readonly tenantId: string;
	readonly sessionId: string;
	readonly clientRequestId: string;
	readonly requestHash: string;
	readonly lane: string;
	readonly operationId: string | null;
	readonly status: SubmissionStatus;
	readonly resultRef: string | null;
	readonly errorCode: string | null;
	readonly createdAt: number;
	readonly updatedAt: number;
};

export type CreateSubmission = {
	readonly id?: string;
	readonly userId: string;
	readonly tenantId: string;
	readonly sessionId: string;
	readonly clientRequestId: string;
	readonly prompt: string;
	readonly lane?: string;
	readonly now?: number;
};

export type AdmissionDriveJob = {
	readonly sessionId: string;
	readonly lane: string;
	readonly availableAt?: number;
	readonly lease?: SessionLease;
};
export type SubmissionRequest = { readonly submissionId: string; readonly lane: string; readonly operationId: string; readonly prompt: string };
const ALLOWED: Record<SubmissionStatus, readonly SubmissionStatus[]> = {
	accepted: ["running", "cancelled"], running: ["waiting", "completed", "failed", "cancelled"],
	waiting: ["running", "cancelled"], completed: [], failed: [], cancelled: [],
};

export function submissionRequestHash(prompt: string): string {
	return createHash("sha256").update(prompt, "utf8").digest("hex");
}

type SubmissionRow = {
	id: string; user_id: string; tenant_id: string; session_id: string; client_request_id: string; request_hash: string; lane: string;
	operation_id: string | null; status: SubmissionStatus; result_ref: string | null;
	error_code: string | null; created_at: string | number; updated_at: string | number;
};

function numberValue(value: string | number): number {
	const result = typeof value === "number" ? value : Number(value);
	if (!Number.isSafeInteger(result)) throw new Error(`Unsafe submission timestamp: ${String(value)}`);
	return result;
}

function fromRow(row: SubmissionRow): Submission {
	return { id: row.id, userId: row.user_id, tenantId: row.tenant_id, sessionId: row.session_id,
	clientRequestId: row.client_request_id, requestHash: row.request_hash, lane: row.lane, operationId: row.operation_id,
		status: row.status, resultRef: row.result_ref, errorCode: row.error_code,
		createdAt: numberValue(row.created_at), updatedAt: numberValue(row.updated_at) };
}

const COLUMNS = "id, user_id, tenant_id, session_id, client_request_id, request_hash, lane, operation_id, status, result_ref, error_code, created_at, updated_at";

/** Durable product-level request state. It stores references to Pi state, never its transcript or credentials. */
export class SubmissionRepo {
	constructor(private readonly executor: SqlExecutor, private readonly clock: () => number = Date.now) {}

	async create(input: CreateSubmission): Promise<{ submission: Submission; created: boolean }> {
		if (input.prompt.length === 0) throw new Error("Submission prompt must not be empty");
		if ([input.userId, input.tenantId, input.sessionId, input.clientRequestId].some((value) => value.length === 0)) throw new Error("Submission identity fields must not be empty");
		const id = input.id ?? randomUUID();
		const now = input.now ?? this.clock();
		const requestHash = submissionRequestHash(input.prompt);
		const lane = input.lane ?? "main";
		if (lane.length === 0) throw new Error("Submission lane must not be empty");
		return this.executor.transaction(async (transaction) => {
			const result = await transaction.query<SubmissionRow>(
				`INSERT INTO agent_submissions (${COLUMNS}) VALUES ($1,$2,$3,$4,$5,$6,$8,NULL,'accepted',NULL,NULL,$7,$7)
				 ON CONFLICT (user_id, tenant_id, session_id, client_request_id) DO NOTHING
				 RETURNING ${COLUMNS}`,
				[id, input.userId, input.tenantId, input.sessionId, input.clientRequestId, requestHash, now, lane],
			);
			if (result.rows[0] !== undefined) {
				await transaction.query("INSERT INTO agent_submission_requests (submission_id, lane, operation_id, prompt) VALUES ($1,$2,$1,$3)", [id, lane, input.prompt]);
				return { submission: fromRow(result.rows[0]), created: true };
			}
			const existing = await transaction.query<SubmissionRow>(
				`SELECT ${COLUMNS} FROM agent_submissions WHERE user_id=$1 AND tenant_id=$2 AND session_id=$3 AND client_request_id=$4 FOR SHARE`,
				[input.userId, input.tenantId, input.sessionId, input.clientRequestId],
			);
			if (existing.rows[0] === undefined) throw new Error("Submission disappeared during idempotent create");
			if (existing.rows[0].request_hash !== requestHash) throw new Error("Submission idempotency key reused with different prompt");
			if (existing.rows[0].lane !== lane) throw new Error("Submission idempotency key reused with different lane");
			return { submission: fromRow(existing.rows[0]), created: false };
		});
	}

	async get(id: string): Promise<Submission | undefined> {
		const result = await this.executor.query<SubmissionRow>(`SELECT ${COLUMNS} FROM agent_submissions WHERE id=$1`, [id]);
		return result.rows[0] === undefined ? undefined : fromRow(result.rows[0]);
	}

	async getRequest(id: string): Promise<SubmissionRequest | undefined> {
		const result = await this.executor.query<{ submission_id: string; lane: string; operation_id: string; prompt: string }>("SELECT submission_id, lane, operation_id, prompt FROM agent_submission_requests WHERE submission_id=$1", [id]);
		const row = result.rows[0];
		return row === undefined ? undefined : { submissionId: row.submission_id, lane: row.lane, operationId: row.operation_id, prompt: row.prompt };
	}

	async listPending(limit = 100): Promise<Submission[]> {
		if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("Submission scan limit must be positive");
		const result = await this.executor.query<SubmissionRow>(`SELECT ${COLUMNS} FROM agent_submissions WHERE status='accepted' AND operation_id IS NULL ORDER BY created_at, id LIMIT $1`, [limit]);
		return result.rows.map(fromRow);
	}

	/** Serializes admission for one submission across Function processes. */
	async withAdmissionLock<T>(id: string, callback: (submission: Submission) => Promise<T>): Promise<T> {
		return this.executor.transaction(async (transaction) => {
			await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [id]);
			const result = await transaction.query<SubmissionRow>(`SELECT ${COLUMNS} FROM agent_submissions WHERE id=$1`, [id]);
			if (result.rows[0] === undefined) throw new Error(`Unknown submission: ${id}`);
			return callback(fromRow(result.rows[0]));
		});
	}

	async attachOperation(id: string, operationId: string): Promise<Submission> {
		try {
			return await this.transition(id, ["accepted"], { operationId, status: "running" });
		} catch (error) {
			const existing = await this.get(id);
			if (existing?.operationId !== null && existing !== undefined) return existing;
			throw error;
		}
	}

	/** Atomically attaches Pi identity and publishes its first durable drive job. */
	async attachOperationAndEnqueue(id: string, operationId: string, job: AdmissionDriveJob): Promise<Submission> {
		if (operationId.length === 0 || job.sessionId.length === 0 || job.lane.length === 0) throw new Error("Admission operation and job identity fields must not be empty");
		const now = this.clock();
		const availableAt = job.availableAt ?? now;
		if (!Number.isSafeInteger(availableAt)) throw new Error("Admission drive job availableAt must be a safe integer");
		return this.executor.transaction(async (transaction) => {
			if (job.lease !== undefined) {
				if (job.lease.sessionId !== job.sessionId) throw new Error("Admission lease session mismatch");
				await assertSessionLease(transaction, job.lease);
			}
			const current = await transaction.query<SubmissionRow>(`SELECT ${COLUMNS} FROM agent_submissions WHERE id=$1 FOR UPDATE`, [id]);
			const row = current.rows[0];
			if (row === undefined) throw new Error(`Unknown submission: ${id}`);
			if (row.session_id !== job.sessionId) throw new Error("Admission job session mismatch");
			if (row.lane !== job.lane) throw new Error("Admission job lane mismatch");
			if (row.operation_id === null) {
				if (row.status !== "accepted") throw new Error(`Submission transition rejected: ${id}`);
				const attached = await transaction.query<SubmissionRow>(
					`UPDATE agent_submissions SET operation_id=$2, status='running', updated_at=$3 WHERE id=$1 AND status='accepted' RETURNING ${COLUMNS}`,
					[id, operationId, now],
				);
				if (attached.rows[0] === undefined) throw new Error(`Submission transition rejected: ${id}`);
			} else if (row.operation_id !== operationId) {
				return fromRow(row);
			}
			const updated = await transaction.query<SubmissionRow>(`SELECT ${COLUMNS} FROM agent_submissions WHERE id=$1`, [id]);
			const submission = updated.rows[0];
			if (submission === undefined) throw new Error(`Submission disappeared during admission: ${id}`);
			if (submission.status === "running") {
				const published = await transaction.query(
					`INSERT INTO agent_drive_jobs (id, submission_id, session_id, lane, operation_id, status, attempt_count, available_at, deferred_handle, claim_owner, claim_epoch, claim_expires_at, last_error, created_at, updated_at)
					 VALUES ($1,$2,$3,$4,$5,'queued',0,$6,NULL,NULL,0,NULL,NULL,$7,$7)
					 ON CONFLICT (session_id, lane, operation_id) DO UPDATE
					 SET submission_id=COALESCE(agent_drive_jobs.submission_id, EXCLUDED.submission_id)
					 WHERE agent_drive_jobs.submission_id IS NULL OR agent_drive_jobs.submission_id=EXCLUDED.submission_id RETURNING id`,
					[randomUUID(), id, job.sessionId, job.lane, operationId, availableAt, now],
				);
				if (published.rowCount !== 1) throw new Error("Admission job submission mismatch");
				await transaction.query("DELETE FROM agent_submission_requests WHERE submission_id=$1", [id]);
			}
			return fromRow(submission);
		});
	}

	async transition(id: string, from: readonly SubmissionStatus[], update: { status: SubmissionStatus; operationId?: string; resultRef?: string; errorCode?: string }): Promise<Submission> {
		if (from.length === 0) throw new Error("Transition requires a source status");
		if (from.some((status) => !ALLOWED[status].includes(update.status))) throw new Error(`Invalid submission transition to ${update.status}`);
		const values: unknown[] = [id, update.status, this.clock()];
		const assignments = ["status=$2", "updated_at=$3"];
		const predicates: string[] = [];
		if (update.operationId !== undefined) { values.push(update.operationId); assignments.push(`operation_id=COALESCE(operation_id,$${values.length})`); predicates.push(`(operation_id IS NULL OR operation_id=$${values.length})`); }
		if (update.resultRef !== undefined) { values.push(update.resultRef); assignments.push(`result_ref=$${values.length}`); }
		if (update.errorCode !== undefined) { values.push(update.errorCode); assignments.push(`error_code=$${values.length}`); }
		values.push([...from]);
		const result = await this.executor.query<SubmissionRow>(
			`UPDATE agent_submissions SET ${assignments.join(", ")} WHERE id=$1 AND status = ANY($${values.length}::text[])${predicates.length === 0 ? "" : ` AND ${predicates.join(" AND ")}`} RETURNING ${COLUMNS}`,
			values,
		);
		if (result.rows[0] === undefined) throw new Error(`Submission transition rejected: ${id}`);
		return fromRow(result.rows[0]);
	}
}
