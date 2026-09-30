import { createHash, randomUUID } from "node:crypto";
import type { SqlExecutor } from "./sql.ts";

export type SubmissionStatus = "accepted" | "running" | "waiting" | "completed" | "failed" | "cancelled";

export type Submission = {
	readonly id: string;
	readonly userId: string;
	readonly tenantId: string;
	readonly sessionId: string;
	readonly clientRequestId: string;
	readonly requestHash: string;
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
	readonly now?: number;
};
const ALLOWED: Record<SubmissionStatus, readonly SubmissionStatus[]> = {
	accepted: ["running", "cancelled"], running: ["waiting", "completed", "failed", "cancelled"],
	waiting: ["running", "cancelled"], completed: [], failed: [], cancelled: [],
};

export function submissionRequestHash(prompt: string): string {
	return createHash("sha256").update(prompt, "utf8").digest("hex");
}

type SubmissionRow = {
	id: string; user_id: string; tenant_id: string; session_id: string; client_request_id: string; request_hash: string;
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
	clientRequestId: row.client_request_id, requestHash: row.request_hash, operationId: row.operation_id,
		status: row.status, resultRef: row.result_ref, errorCode: row.error_code,
		createdAt: numberValue(row.created_at), updatedAt: numberValue(row.updated_at) };
}

const COLUMNS = "id, user_id, tenant_id, session_id, client_request_id, request_hash, operation_id, status, result_ref, error_code, created_at, updated_at";

/** Durable product-level request state. It stores references to Pi state, never its transcript or credentials. */
export class SubmissionRepo {
	constructor(private readonly executor: SqlExecutor, private readonly clock: () => number = Date.now) {}

	async create(input: CreateSubmission): Promise<{ submission: Submission; created: boolean }> {
		if (input.prompt.length === 0) throw new Error("Submission prompt must not be empty");
		if ([input.userId, input.tenantId, input.sessionId, input.clientRequestId].some((value) => value.length === 0)) throw new Error("Submission identity fields must not be empty");
		const id = input.id ?? randomUUID();
		const now = input.now ?? this.clock();
		const requestHash = submissionRequestHash(input.prompt);
		return this.executor.transaction(async (transaction) => {
			const result = await transaction.query<SubmissionRow>(
				`INSERT INTO agent_submissions (${COLUMNS}) VALUES ($1,$2,$3,$4,$5,$6,NULL,'accepted',NULL,NULL,$7,$7)
				 ON CONFLICT (user_id, tenant_id, session_id, client_request_id) DO NOTHING
				 RETURNING ${COLUMNS}`,
				[id, input.userId, input.tenantId, input.sessionId, input.clientRequestId, requestHash, now],
			);
			if (result.rows[0] !== undefined) return { submission: fromRow(result.rows[0]), created: true };
			const existing = await transaction.query<SubmissionRow>(
				`SELECT ${COLUMNS} FROM agent_submissions WHERE user_id=$1 AND tenant_id=$2 AND session_id=$3 AND client_request_id=$4 FOR SHARE`,
				[input.userId, input.tenantId, input.sessionId, input.clientRequestId],
			);
			if (existing.rows[0] === undefined) throw new Error("Submission disappeared during idempotent create");
			if (existing.rows[0].request_hash !== requestHash) throw new Error("Submission idempotency key reused with different prompt");
			return { submission: fromRow(existing.rows[0]), created: false };
		});
	}

	async get(id: string): Promise<Submission | undefined> {
		const result = await this.executor.query<SubmissionRow>(`SELECT ${COLUMNS} FROM agent_submissions WHERE id=$1`, [id]);
		return result.rows[0] === undefined ? undefined : fromRow(result.rows[0]);
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
