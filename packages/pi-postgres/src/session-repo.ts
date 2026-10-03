import { uuidv7 } from "@earendil-works/pi-agent-core";
import {
	StorageBackedSession,
	type Session,
	type SessionCreateOptions,
	type SessionMetadata,
	type SessionRepo,
	type ForkOptions,
	operationMeta, operationState, operationResult,
	type OperationMeta, type OperationState, type OperationResultRecord, type Entry,
} from "@earendil-works/pi-agent-core/harness/session";
import type { Context } from "@earendil-works/pi-agent-core/harness/context";
import { deletePiPostgresSession, ensurePiPostgresSchema } from "./schema.ts";
import { PostgresStorage } from "./storage.ts";
import type { SqlExecutor } from "./sql.ts";
import type { SessionLease } from "./lease.ts";
import { assertSessionLease } from "./lease.ts";

const STORAGE_VERSION = 1;

type SessionRow = {
	id: string;
	created_at: string | number;
	storage_version: number;
	parent_session_id: string | null;
};

type EntryCopyRow = {
	id: string;
	parent_id: string | null;
	seq: string | number;
	timestamp_ms: string | number;
	entry_type: string;
	custom_type: string | null;
	payload: unknown;
};

type ValueCopyRow = {
	namespace: string;
	value_key: string;
	seq: string | number;
	value: unknown;
};

type ListCopyRow = {
	namespace: string;
	list_key: string;
	seq: string | number;
	value: unknown;
};

type ForkSelection = {
	entryIds: Set<string>;
	branchPlan?: { branch: string; destinationTip: string | null };
};

const IDLE_LANE_STATE = { currentOperationId: null, lastOperationId: null, inbox: [] } as const;
export type SessionOwner = { readonly userId: string; readonly tenantId: string };
export class SessionForkConflictError extends Error {
	constructor(id: string) { super(`Fork destination already exists: ${id}`); this.name = "SessionForkConflictError"; }
}
export type PostgresOperationSnapshot = { readonly meta?: OperationMeta; readonly state?: OperationState; readonly result?: OperationResultRecord };

function toNumber(value: string | number): number {
	const result = typeof value === "number" ? value : Number(value);
	if (!Number.isSafeInteger(result)) throw new Error(`Unsafe session timestamp: ${String(value)}`);
	return result;
}

function metadataFromRow(row: SessionRow): SessionMetadata {
	return {
		id: row.id,
		createdAt: toNumber(row.created_at),
		storageVersion: row.storage_version,
		...(row.parent_session_id === null ? {} : { parentSessionId: row.parent_session_id }),
	};
}

/** Session repository backed by the same SQL executor as PostgresStorage. */
export class PostgresSessionRepo implements SessionRepo {
	private readonly openSessions = new Map<string, Session>();
	private readonly openStorages = new Map<string, PostgresStorage>();
	private readonly pendingCreates = new Set<string>();
	private closed = false;
	private closePromise: Promise<void> | undefined;

	constructor(
		private readonly executor: SqlExecutor,
		private readonly now: () => number = Date.now,
	) {}

	async create(options: SessionCreateOptions, context: Context): Promise<Session> {
		return this.createInternal(options, undefined, context);
	}

	async createWithLease(options: SessionCreateOptions, lease: SessionLease, context: Context): Promise<Session> {
		if (options.id !== undefined && options.id !== lease.sessionId) {
			throw new Error(`Lease session does not match: ${options.id}`);
		}
		return this.createInternal({ ...options, id: lease.sessionId }, lease, context);
	}

	async createWithOwner(owner: SessionOwner, context: Context): Promise<Session> {
		if (owner.userId.length === 0 || owner.tenantId.length === 0) throw new Error("Session owner identity must not be empty");
		return this.createInternal({}, undefined, context, owner);
	}

	private async createInternal(options: SessionCreateOptions, lease: SessionLease | undefined, context: Context, owner?: SessionOwner): Promise<Session> {
		this.assertOpen();
		const id = options.id ?? uuidv7(this.now());
		if (this.openSessions.has(id) || this.pendingCreates.has(id)) throw new Error(`Session already open: ${id}`);
		this.pendingCreates.add(id);
		const createdAt = this.now();
		try {
			await ensurePiPostgresSchema(this.executor);
			await this.executor.transaction(async (transaction) => {
				if (lease !== undefined) await assertSessionLease(transaction, lease);
				await transaction.query(
					`INSERT INTO pi_poc_sessions (id, created_at, storage_version, parent_session_id)
					 VALUES ($1, $2, $3, $4)`,
					[id, createdAt, STORAGE_VERSION, options.parentSessionId ?? null],
				);
				if (owner !== undefined) await transaction.query("INSERT INTO agent_session_access (session_id, user_id, tenant_id) VALUES ($1,$2,$3)", [id, owner.userId, owner.tenantId]);
			});
			const metadata: SessionMetadata = {
				id,
				createdAt,
				storageVersion: STORAGE_VERSION,
				...(options.parentSessionId === undefined ? {} : { parentSessionId: options.parentSessionId }),
			};
			return this.openHandle(metadata, context, lease);
		} finally {
			this.pendingCreates.delete(id);
		}
	}

	async open(metadata: SessionMetadata, _context: Context): Promise<Session> {
		return this.openInternal(metadata, undefined, _context);
	}

	async openWithLease(metadata: SessionMetadata, lease: SessionLease, context: Context): Promise<Session> {
		if (lease.sessionId !== metadata.id) throw new Error(`Lease session does not match: ${metadata.id}`);
		return this.openInternal(metadata, lease, context);
	}

	private async openInternal(metadata: SessionMetadata, lease: SessionLease | undefined, _context: Context): Promise<Session> {
		this.assertOpen();
		if (this.openSessions.has(metadata.id)) throw new Error(`Session is already open: ${metadata.id}`);
		const result = await this.executor.query<SessionRow>(
			"SELECT id, created_at, storage_version, parent_session_id FROM pi_poc_sessions WHERE id = $1",
			[metadata.id],
		);
		const row = result.rows[0];
		if (row === undefined) throw new Error(`Unknown session: ${metadata.id}`);
		if (row.storage_version !== STORAGE_VERSION) throw new Error(`Unsupported session storage version: ${row.storage_version}`);
		return this.openHandle(metadataFromRow(row), _context, lease);
	}

	async list(_options: undefined, _context: Context): Promise<SessionMetadata[]> {
		this.assertOpen();
		const result = await this.executor.query<SessionRow>(
			"SELECT id, created_at, storage_version, parent_session_id FROM pi_poc_sessions ORDER BY id ASC",
		);
		return result.rows.map(metadataFromRow);
	}

	async authorizedMetadata(id: string, userId: string, tenantId: string): Promise<SessionMetadata | undefined> {
		this.assertOpen();
		const rows = await this.executor.query<SessionRow>("SELECT s.id, s.created_at, s.storage_version, s.parent_session_id FROM pi_poc_sessions s JOIN agent_session_access a ON a.session_id=s.id WHERE s.id=$1 AND a.user_id=$2 AND a.tenant_id=$3", [id, userId, tenantId]);
		return rows.rows[0] === undefined ? undefined : metadataFromRow(rows.rows[0]);
	}

	/** One SQL snapshot observes the atomic Pi state/result boundary without opening a writer. */
	async readOperation(sessionId: string, operationId: string): Promise<PostgresOperationSnapshot> {
		this.assertOpen();
		const meta = operationMeta(operationId); const state = operationState(operationId); const result = operationResult(operationId);
		const rows = await this.executor.query<{ namespace: string; value: unknown }>("SELECT namespace, value FROM pi_poc_storage_values WHERE session_id=$1 AND value_key=$2 AND namespace=ANY($3::text[])", [sessionId, operationId, [meta.namespace, state.namespace, result.namespace]]);
		const snapshot: { meta?: OperationMeta; state?: OperationState; result?: OperationResultRecord } = {};
		for (const row of rows.rows) {
			if (row.namespace === meta.namespace) snapshot.meta = row.value as OperationMeta;
			else if (row.namespace === state.namespace) snapshot.state = row.value as OperationState;
			else if (row.namespace === result.namespace) snapshot.result = row.value as OperationResultRecord;
		}
		return snapshot;
	}

	async readEntry(sessionId: string, entryId: string, context: Context): Promise<Entry | undefined> {
		this.assertOpen();
		const storage = new PostgresStorage(this.executor, sessionId);
		try { return (await storage.getEntries([entryId], context)).get(entryId); }
		finally { await storage.close(context); }
	}

	async delete(metadata: SessionMetadata, _context: Context): Promise<void> {
		this.assertOpen();
		if (this.openSessions.has(metadata.id)) throw new Error(`Session is open: ${metadata.id}`);
		const result = await this.executor.query<{ id: string }>("SELECT id FROM pi_poc_sessions WHERE id = $1", [metadata.id]);
		if (result.rows.length === 0) throw new Error(`Unknown session: ${metadata.id}`);
		await deletePiPostgresSession(this.executor, metadata.id);
	}

	/** Native/internal API: does not attach application ownership. */
	async fork(source: SessionMetadata, options: ForkOptions, context: Context): Promise<Session> {
		return this.forkInternal(source, options, undefined, context);
	}

	/** Source authorization belongs to the caller; ownership commits with all fork data. */
	async forkWithOwner(source: SessionMetadata, options: ForkOptions, owner: SessionOwner, context: Context): Promise<Session> {
		if (owner.userId.length === 0 || owner.tenantId.length === 0) throw new Error("Session owner identity must not be empty");
		return this.forkInternal(source, options, owner, context);
	}

	private async forkInternal(source: SessionMetadata, options: ForkOptions, owner: SessionOwner | undefined, context: Context): Promise<Session> {
		this.assertOpen();
		const id = options.id ?? uuidv7(this.now());
		if (this.openSessions.has(id) || this.pendingCreates.has(id)) throw new SessionForkConflictError(id);
		this.pendingCreates.add(id);
		try {
			await ensurePiPostgresSchema(this.executor);
			const sourceStorage = this.openStorages.get(source.id);
			if (sourceStorage !== undefined) await sourceStorage.whenIdle();
			const metadata = await this.copyFork(source, options, id, owner);
			return this.openHandle(metadata, context);
		} catch (error) {
			// Only a session primary-key collision is a destination conflict.
			if (error !== null && typeof error === "object" && "code" in error && error.code === "23505" && "constraint" in error && error.constraint === "pi_poc_sessions_pkey") throw new SessionForkConflictError(id);
			throw error;
		} finally {
			this.pendingCreates.delete(id);
		}
	}

	async close(context: Context): Promise<void> {
		if (this.closePromise !== undefined) return this.closePromise;
		this.closed = true;
		this.closePromise = Promise.all([...this.openSessions.values()].map((session) => session.close(context))).then(() => undefined);
		return this.closePromise;
	}

	private async openHandle(metadata: SessionMetadata, _context: Context, lease: SessionLease | undefined = undefined): Promise<Session> {
		if (this.openSessions.has(metadata.id)) throw new Error(`Session is already open: ${metadata.id}`);
		const storage = new PostgresStorage(this.executor, metadata.id, this.now, lease);
		const session = new StorageBackedSession(metadata, storage, {
			onClose: () => {
				this.openSessions.delete(metadata.id);
				this.openStorages.delete(metadata.id);
			},
		});
		this.openSessions.set(metadata.id, session);
		this.openStorages.set(metadata.id, storage);
		return session;
	}

	private async copyFork(source: SessionMetadata, options: ForkOptions, id: string, owner?: SessionOwner): Promise<SessionMetadata> {
		const createdAt = this.now();
		return this.executor.transaction(async (transaction) => {
			await transaction.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
			const sourceRows = await transaction.query<SessionRow>(
				"SELECT id, created_at, storage_version, parent_session_id FROM pi_poc_sessions WHERE id = $1",
				[source.id],
			);
			if (sourceRows.rows.length === 0) throw new Error(`Unknown session: ${source.id}`);
			const sourceRow = sourceRows.rows[0]!;
			if (sourceRow.storage_version !== STORAGE_VERSION) {
				throw new Error(`Unsupported session storage version: ${sourceRow.storage_version}`);
			}

			const entries = await transaction.query<EntryCopyRow>(
				`SELECT id, parent_id, seq, timestamp_ms, entry_type, custom_type, payload
				 FROM pi_poc_storage_entries WHERE session_id = $1 ORDER BY seq ASC`,
				[source.id],
			);
			const values = await transaction.query<ValueCopyRow>(
				"SELECT namespace, value_key, seq, value FROM pi_poc_storage_values WHERE session_id = $1",
				[source.id],
			);
			const lists = await transaction.query<ListCopyRow>(
				"SELECT namespace, list_key, seq, value FROM pi_poc_storage_lists WHERE session_id = $1 ORDER BY seq ASC",
				[source.id],
			);
			const selection = this.selectForkEntries(entries.rows, values.rows, options);
			const copiedValues = this.projectForkValues(values.rows, selection, options);
			const copiedLists = this.projectForkLists(lists.rows, options);

			await transaction.query(
				`INSERT INTO pi_poc_sessions (id, created_at, storage_version, parent_session_id)
				 VALUES ($1, $2, $3, $4)`,
				[id, createdAt, STORAGE_VERSION, source.id],
			);
			for (const entry of entries.rows) {
				if (!selection.entryIds.has(entry.id)) continue;
				await transaction.query(
					`INSERT INTO pi_poc_storage_entries
					 (session_id, id, parent_id, seq, timestamp_ms, entry_type, custom_type, payload)
					 VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
					[
						id,
						entry.id,
						entry.parent_id,
					toNumber(entry.seq),
					toNumber(entry.timestamp_ms),
						entry.entry_type,
						entry.custom_type,
						JSON.stringify(entry.payload ?? {}),
					],
				);
			}
			for (const value of copiedValues) {
				await transaction.query(
					`INSERT INTO pi_poc_storage_values (session_id, namespace, value_key, seq, value)
					 VALUES ($1, $2, $3, $4, $5::jsonb)`,
					[id, value.namespace, value.value_key, toNumber(value.seq), JSON.stringify(value.value)],
				);
			}
			for (const list of copiedLists) {
				await transaction.query(
					`INSERT INTO pi_poc_storage_lists (session_id, namespace, list_key, seq, value)
					 VALUES ($1, $2, $3, $4, $5::jsonb)`,
					[id, list.namespace, list.list_key, toNumber(list.seq), JSON.stringify(list.value)],
				);
			}
			const sequence = await transaction.query<{ next_seq: string | number }>(
				"SELECT next_seq FROM pi_poc_storage_sequences WHERE session_id = $1",
				[source.id],
			);
			if (sequence.rows[0] !== undefined) {
				await transaction.query(
					"INSERT INTO pi_poc_storage_sequences (session_id, next_seq) VALUES ($1, $2)",
					[id, toNumber(sequence.rows[0].next_seq)],
				);
			}
			if (owner !== undefined) {
				await transaction.query("INSERT INTO agent_session_access (session_id, user_id, tenant_id) VALUES ($1,$2,$3)", [id, owner.userId, owner.tenantId]);
			}
			return {
				id,
				createdAt,
				storageVersion: STORAGE_VERSION,
				parentSessionId: source.id,
			};
		});
	}

	private selectForkEntries(entries: readonly EntryCopyRow[], values: readonly ValueCopyRow[], options: ForkOptions): ForkSelection {
		const entryMap = new Map(entries.map((entry) => [entry.id, entry]));
		const tips = values.filter((value) => value.namespace === "pi.branch.tip");
		const tipKeys = new Set(tips.map((tip) => tip.value_key));
		for (const value of values) {
			if ((value.namespace === "pi.lane.config" || value.namespace === "pi.lane.state") && !tipKeys.has(value.value_key)) {
				throw new Error(`Source session branch ${JSON.stringify(value.value_key)} is missing branch.tip`);
			}
		}
		for (const tip of tips) {
			const config = values.some((value) => value.namespace === "pi.lane.config" && value.value_key === tip.value_key);
			const state = values.some((value) => value.namespace === "pi.lane.state" && value.value_key === tip.value_key);
			if (config !== state) throw new Error(`Source session branch ${JSON.stringify(tip.value_key)} has incomplete lane state`);
			if (options.scope === "branch" && tip.value_key === options.branch && !config) {
				throw new Error(`Source branch ${JSON.stringify(options.branch)} is not a configured AgentLane`);
			}
			if (tip.value !== null && !entryMap.has(String(tip.value))) {
				throw new Error(`Source session branch ${JSON.stringify(tip.value_key)} has an unknown tip`);
			}
		}
		if (options.scope === "tree") return { entryIds: new Set(entries.map((entry) => entry.id)) };
		const tip = tips.find((value) => value.value_key === options.branch);
		if (tip === undefined) throw new Error(`Unknown source branch: ${options.branch}`);
		const requested = options.entryId ?? (tip.value === null ? null : String(tip.value));
		const selected = new Set<string>();
		let found = requested === null;
		let destinationTip: string | null = null;
		let entryId = tip.value === null ? null : String(tip.value);
		while (entryId !== null) {
			const entry = entryMap.get(entryId);
			if (entry === undefined) throw new Error(`Corrupt source branch: missing parent ${entryId}`);
			if (entryId === requested) {
				found = true;
				destinationTip = options.position === "before" ? entry.parent_id : entryId;
				if (options.position !== "before") selected.add(entryId);
			} else if (found) {
				selected.add(entryId);
			}
			entryId = entry.parent_id;
		}
		if (!found) throw new Error(`Fork entry ${requested} is not on source branch ${JSON.stringify(options.branch)}`);
		return { entryIds: selected, branchPlan: { branch: options.branch, destinationTip } };
	}

	private projectForkValues(values: readonly ValueCopyRow[], selection: ForkSelection, options: ForkOptions): ValueCopyRow[] {
		const branchPlan = options.scope === "branch" ? selection.branchPlan : undefined;
		return values.flatMap((value) => {
			const { namespace, value_key: key } = value;
			if (namespace === "pi.session.name") return [value];
			if (namespace === "pi.entry.label") return selection.entryIds.has(key) ? [value] : [];
			if (namespace === "pi.branch.tip") {
				if (options.scope === "tree") return [value];
				return key === branchPlan?.branch ? [{ ...value, value: branchPlan.destinationTip }] : [];
			}
			if (namespace === "pi.lane.config") {
				return options.scope === "tree" || key === branchPlan?.branch ? [value] : [];
			}
			if (namespace === "pi.lane.state") {
				return options.scope === "tree" || key === branchPlan?.branch ? [{ ...value, value: IDLE_LANE_STATE }] : [];
			}
			if (namespace === "pi.result" || namespace.startsWith("pi.op.") || namespace.startsWith("pi.pending.")) return [];
			if (namespace === "pi" || namespace.startsWith("pi.")) throw new Error(`Unknown reserved fork namespace: ${namespace}`);
			return options.scope === "tree" ? [value] : [];
		});
	}

	private projectForkLists(lists: readonly ListCopyRow[], options: ForkOptions): ListCopyRow[] {
		if (options.scope === "branch") return [];
		return lists.flatMap((list) => {
			if (list.namespace === "pi.result" || list.namespace.startsWith("pi.op.") || list.namespace.startsWith("pi.pending.")) return [];
			if (list.namespace === "pi" || list.namespace.startsWith("pi.")) {
				throw new Error(`Unknown reserved fork namespace: ${list.namespace}`);
			}
			return [list];
		});
	}

	private assertOpen(): void {
		if (this.closed) throw new Error("PostgresSessionRepo is closed");
	}
}
