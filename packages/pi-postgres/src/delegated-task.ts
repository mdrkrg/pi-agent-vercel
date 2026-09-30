import { randomUUID } from "node:crypto";
import type { SqlExecutor } from "./sql.ts";

export type DelegatedTaskStatus = "accepted" | "running" | "waiting" | "completed" | "failed" | "cancelled";
const ALLOWED: Record<DelegatedTaskStatus, readonly DelegatedTaskStatus[]> = { accepted: ["running", "cancelled"], running: ["waiting", "completed", "failed", "cancelled"], waiting: ["running", "cancelled"], completed: [], failed: [], cancelled: [] };
export type DelegatedTask = {
	readonly id: string; readonly parentSubmissionId: string; readonly idempotencyKey: string; readonly userId: string; readonly tenantId: string;
	readonly status: DelegatedTaskStatus; readonly checkpointRef: string | null; readonly artifactRef: string | null;
	readonly errorCode: string | null; readonly createdAt: number; readonly updatedAt: number;
};
type Row = { id: string; parent_submission_id: string; idempotency_key: string; user_id: string; tenant_id: string; status: DelegatedTaskStatus;
	checkpoint_ref: string | null; artifact_ref: string | null; error_code: string | null; created_at: string | number; updated_at: string | number };
const COLUMNS = "id,parent_submission_id,idempotency_key,user_id,tenant_id,status,checkpoint_ref,artifact_ref,error_code,created_at,updated_at";
const n = (v: string | number): number => { const x = typeof v === "number" ? v : Number(v); if (!Number.isSafeInteger(x)) throw new Error(`Unsafe task timestamp: ${v}`); return x; };
const map = (r: Row): DelegatedTask => ({ id: r.id, parentSubmissionId: r.parent_submission_id, idempotencyKey: r.idempotency_key, userId: r.user_id, tenantId: r.tenant_id,
	status: r.status, checkpointRef: r.checkpoint_ref, artifactRef: r.artifact_ref, errorCode: r.error_code, createdAt: n(r.created_at), updatedAt: n(r.updated_at) });

/** Durable child work stores only authorization, lifecycle, checkpoints, and artifact references. */
export class DelegatedTaskRepo {
	constructor(private readonly executor: SqlExecutor, private readonly clock: () => number = Date.now) {}
	async create(input: { id?: string; parentSubmissionId: string; idempotencyKey: string; userId: string; tenantId: string }): Promise<DelegatedTask> {
		if ([input.parentSubmissionId, input.idempotencyKey, input.userId, input.tenantId].some((value) => value.length === 0)) throw new Error("Task identity fields must not be empty");
		const id = input.id ?? randomUUID(); const now = this.clock();
		return this.executor.transaction(async (transaction) => {
			const parent = await transaction.query<{ id: string; user_id: string; tenant_id: string }>("SELECT id, user_id, tenant_id FROM agent_submissions WHERE id=$1 FOR SHARE", [input.parentSubmissionId]);
			const parentRow = parent.rows[0];
			if (parentRow === undefined) throw new Error(`Unknown parent submission: ${input.parentSubmissionId}`);
			if (parentRow.user_id !== input.userId || parentRow.tenant_id !== input.tenantId) throw new Error("Parent submission authorization mismatch");
			const result = await transaction.query<Row>(`INSERT INTO agent_delegated_tasks (${COLUMNS}) VALUES ($1,$2,$3,$4,$5,'accepted',NULL,NULL,NULL,$6,$6) ON CONFLICT (parent_submission_id,idempotency_key) DO NOTHING RETURNING ${COLUMNS}`,
				[id, input.parentSubmissionId, input.idempotencyKey, input.userId, input.tenantId, now]);
			if (result.rows[0] !== undefined) return map(result.rows[0]);
			const existing = await transaction.query<Row>(`SELECT ${COLUMNS} FROM agent_delegated_tasks WHERE parent_submission_id=$1 AND idempotency_key=$2`, [input.parentSubmissionId, input.idempotencyKey]);
			if (existing.rows[0] === undefined) throw new Error("Task disappeared during idempotent create"); return map(existing.rows[0]);
		});
	}
	async get(id: string): Promise<DelegatedTask | undefined> { const r = await this.executor.query<Row>(`SELECT ${COLUMNS} FROM agent_delegated_tasks WHERE id=$1`, [id]); return r.rows[0] === undefined ? undefined : map(r.rows[0]); }
	async getAuthorized(id: string, userId: string, tenantId: string): Promise<DelegatedTask | undefined> {
		const r = await this.executor.query<Row>(`SELECT ${COLUMNS} FROM agent_delegated_tasks WHERE id=$1 AND user_id=$2 AND tenant_id=$3`, [id, userId, tenantId]);
		return r.rows[0] === undefined ? undefined : map(r.rows[0]);
	}
	async transition(id: string, from: readonly DelegatedTaskStatus[], status: DelegatedTaskStatus, refs: { checkpointRef?: string; artifactRef?: string; errorCode?: string } = {}): Promise<DelegatedTask> {
		if (from.length === 0 || from.some((source) => !ALLOWED[source].includes(status))) throw new Error(`Invalid task transition to ${status}`);
		const values: unknown[] = [id, status, this.clock()]; const sets = ["status=$2", "updated_at=$3"];
		for (const [column, value] of [["checkpoint_ref", refs.checkpointRef], ["artifact_ref", refs.artifactRef], ["error_code", refs.errorCode]] as const) if (value !== undefined) { values.push(value); sets.push(`${column}=$${values.length}`); }
		values.push([...from]); const r = await this.executor.query<Row>(`UPDATE agent_delegated_tasks SET ${sets.join(",")} WHERE id=$1 AND status=ANY($${values.length}::text[]) RETURNING ${COLUMNS}`, values);
		if (r.rows[0] === undefined) throw new Error(`Task transition rejected: ${id}`); return map(r.rows[0]);
	}
	async transitionAuthorized(id: string, userId: string, tenantId: string, from: readonly DelegatedTaskStatus[], status: DelegatedTaskStatus, refs: { checkpointRef?: string; artifactRef?: string; errorCode?: string } = {}): Promise<DelegatedTask> {
		if (from.length === 0 || from.some((source) => !ALLOWED[source].includes(status))) throw new Error(`Invalid task transition to ${status}`);
		const values: unknown[] = [id, userId, tenantId, status, this.clock()]; const sets = ["status=$4", "updated_at=$5"];
		for (const [column, value] of [["checkpoint_ref", refs.checkpointRef], ["artifact_ref", refs.artifactRef], ["error_code", refs.errorCode]] as const) if (value !== undefined) { values.push(value); sets.push(`${column}=$${values.length}`); }
		values.push([...from]); const r = await this.executor.query<Row>(`UPDATE agent_delegated_tasks SET ${sets.join(",")} WHERE id=$1 AND user_id=$2 AND tenant_id=$3 AND status=ANY($${values.length}::text[]) RETURNING ${COLUMNS}`, values);
		if (r.rows[0] === undefined) throw new Error(`Authorized task transition rejected: ${id}`); return map(r.rows[0]);
	}
}
