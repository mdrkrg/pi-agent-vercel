import type { Context } from "@earendil-works/pi-agent-core/harness/context";
import type {
	CommitResult,
	Entry,
	EntryScan,
	EntryStructure,
	JsonValue,
	SessionStats,
	Storage,
	StorageBranchScan,
	UsageRow,
	UsageScan,
	Write,
} from "@earendil-works/pi-agent-core/harness/session";
import {
	type ListElement,
	resolveListReadOptions,
	type ListReadOptions,
	type StoredValue,
	type Value,
	type ValueList,
} from "@earendil-works/pi-agent-core/harness/session";
import type { SqlExecutor } from "./sql.ts";
import { assertSessionLease, type SessionLease } from "./lease.ts";

type Usage = UsageRow["usage"];

type EntryRow = {
	id: string;
	parent_id: string | null;
	seq: string | number;
	timestamp_ms: string | number;
	entry_type: string;
	custom_type: string | null;
	payload: unknown;
};

type ValueRow = {
	namespace: string;
	value_key: string;
	seq: string | number;
	value: unknown;
};

type ListRow = {
	seq: string | number;
	value: unknown;
};

type UsageRowData = {
	id: string;
	seq: string | number;
	entry_id: string | null;
	adjustment: boolean;
	usage: Usage;
	details: JsonValue | null;
};

type SequenceRow = { next_seq: string | number };

const DEFAULT_PAGE_LIMIT = 1_000;
const MAX_PAGE_LIMIT = 10_000;

function numberValue(value: string | number): number {
	const result = typeof value === "number" ? value : Number(value);
	if (!Number.isSafeInteger(result)) throw new Error(`Unsafe PostgreSQL integer value: ${String(value)}`);
	return result;
}

function jsonValue(value: unknown): string {
	return JSON.stringify(value);
}

function codePointCompare(left: string, right: string): number {
	const leftCodePoints = Array.from(left, (character) => character.codePointAt(0)!);
	const rightCodePoints = Array.from(right, (character) => character.codePointAt(0)!);
	const length = Math.min(leftCodePoints.length, rightCodePoints.length);
	for (let index = 0; index < length; index++) {
		const difference = leftCodePoints[index]! - rightCodePoints[index]!;
		if (difference !== 0) return difference;
	}
	return leftCodePoints.length - rightCodePoints.length;
}

function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function addUsage(left: Usage, right: Usage): Usage {
	return {
		input: left.input + right.input,
		output: left.output + right.output,
		cacheRead: left.cacheRead + right.cacheRead,
		cacheWrite: left.cacheWrite + right.cacheWrite,
		...(left.cacheWrite1h === undefined && right.cacheWrite1h === undefined
			? {}
			: { cacheWrite1h: (left.cacheWrite1h ?? 0) + (right.cacheWrite1h ?? 0) }),
		...(left.reasoning === undefined && right.reasoning === undefined
			? {}
			: { reasoning: (left.reasoning ?? 0) + (right.reasoning ?? 0) }),
		totalTokens: left.totalTokens + right.totalTokens,
		cost: {
			input: left.cost.input + right.cost.input,
			output: left.cost.output + right.cost.output,
			cacheRead: left.cost.cacheRead + right.cost.cacheRead,
			cacheWrite: left.cost.cacheWrite + right.cost.cacheWrite,
			total: left.cost.total + right.cost.total,
		},
	};
}

function entryFromRow(row: EntryRow): Entry {
	const payload = row.payload !== null && typeof row.payload === "object" ? row.payload : {};
	return {
		...payload,
		id: row.id,
		parentId: row.parent_id,
		seq: numberValue(row.seq),
		timestamp: numberValue(row.timestamp_ms),
		type: row.entry_type,
		...(row.custom_type === null ? {} : { customType: row.custom_type }),
	} as Entry;
}

function entryStructure(entry: Entry): EntryStructure {
	return {
		id: entry.id,
		parentId: entry.parentId,
		seq: entry.seq,
		timestamp: entry.timestamp,
		type: entry.type,
		...(entry.customType === undefined ? {} : { customType: entry.customType }),
	};
}

function pageLimit(limit: number | undefined): number {
	if (limit === undefined) return Number.POSITIVE_INFINITY;
	if (!Number.isFinite(limit)) return 0;
	return Math.max(0, Math.trunc(limit));
}

function rowJson<T>(value: unknown): T {
	return value as T;
}

export class PostgresStorage implements Storage {
	private state: "open" | "closing" | "closed" = "open";
	private commitQueue: Promise<void> = Promise.resolve();
	private closePromise: Promise<void> | undefined;

	constructor(
		private readonly executor: SqlExecutor,
		private readonly sessionId: string,
		private readonly now: () => number = Date.now,
		private readonly lease: SessionLease | undefined = undefined,
	) {}

	commit(writes: Write[], _context: Context): Promise<CommitResult> {
		if (this.state !== "open") return Promise.reject(new Error("PostgresStorage is closed"));
		const result = this.commitQueue.then(() => this.commitNow(writes));
		this.commitQueue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	/** Wait until all writes admitted through this storage have settled. */
	whenIdle(): Promise<void> {
		return this.commitQueue;
	}

	private async commitNow(writes: Write[]): Promise<CommitResult> {
		if (writes.length === 0) throw new Error("Storage commit requires at least one write");
		return this.executor.transaction(async (transaction) => {
			if (this.lease !== undefined) await assertSessionLease(transaction, this.lease);
			const timestamp = this.now();
			const firstSeq = await this.reserveSequences(transaction, writes.length);
			await this.validateWrites(transaction, writes);
			const seqs = writes.map((_, index) => firstSeq + index);
			for (let index = 0; index < writes.length; index++) {
				await this.applyWrite(transaction, writes[index]!, seqs[index]!, timestamp);
			}
			return {
				firstSeq,
				seqs,
				timestamp,
				stats: await this.getStatsWith(transaction),
			};
		});
	}

	private async reserveSequences(transaction: SqlExecutor, count: number): Promise<number> {
		await transaction.query(
			`INSERT INTO pi_poc_storage_sequences (session_id, next_seq)
			 VALUES ($1, 1)
			 ON CONFLICT (session_id) DO NOTHING`,
			[this.sessionId],
		);
		const sequence = await transaction.query<SequenceRow>(
			"SELECT next_seq FROM pi_poc_storage_sequences WHERE session_id = $1 FOR UPDATE",
			[this.sessionId],
		);
		const firstSeq = numberValue(sequence.rows[0]?.next_seq ?? 0);
		await transaction.query(
			"UPDATE pi_poc_storage_sequences SET next_seq = $2 WHERE session_id = $1",
			[this.sessionId, firstSeq + count],
		);
		return firstSeq;
	}

	private async validateWrites(transaction: SqlExecutor, writes: Write[]): Promise<void> {
		const ids = writes.flatMap((write) => (write.kind === "entry" || write.kind === "usage" ? [write.kind === "entry" ? write.entry.id : write.row.id] : []));
		const seen = new Set<string>();
		for (const id of ids) {
			if (seen.has(id)) throw new Error(`Duplicate entry or usage id: ${id}`);
			seen.add(id);
		}
		if (ids.length > 0) {
			const existing = await transaction.query<{ id: string }>(
				`SELECT id FROM pi_poc_storage_entries WHERE session_id = $1 AND id = ANY($2::text[])
				 UNION ALL
				 SELECT id FROM pi_poc_storage_usage WHERE session_id = $1 AND id = ANY($2::text[])`,
				[this.sessionId, ids],
			);
			if (existing.rows.length > 0) throw new Error(`Duplicate entry or usage id: ${existing.rows[0]!.id}`);
		}
		const parentIds = writes.flatMap((write) => (write.kind === "entry" && write.entry.parentId !== null ? [write.entry.parentId] : []));
		if (parentIds.length === 0) return;
		const existingParents = await transaction.query<{ id: string }>(
			"SELECT id FROM pi_poc_storage_entries WHERE session_id = $1 AND id = ANY($2::text[])",
			[this.sessionId, parentIds],
		);
		const knownParents = new Set(existingParents.rows.map((row) => row.id));
		for (const write of writes) {
			if (write.kind !== "entry") continue;
			const parentId = write.entry.parentId;
			if (parentId !== null && !knownParents.has(parentId)) {
				throw new Error(`Missing parent entry: ${parentId}`);
			}
			knownParents.add(write.entry.id);
		}
	}

	private async applyWrite(transaction: SqlExecutor, write: Write, seq: number, timestamp: number): Promise<void> {
		switch (write.kind) {
			case "entry":
				await transaction.query(
					`INSERT INTO pi_poc_storage_entries
					 (session_id, id, parent_id, seq, timestamp_ms, entry_type, custom_type, payload)
					 VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
					[
						this.sessionId,
						write.entry.id,
						write.entry.parentId,
						seq,
						timestamp,
						write.entry.type,
						write.entry.type === "custom" ? (write.entry.customType ?? null) : null,
						jsonValue(write.entry),
					],
				);
				return;
			case "usage":
				await transaction.query(
					`INSERT INTO pi_poc_storage_usage
					 (session_id, id, seq, entry_id, adjustment, usage, details)
					 VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)`,
					[
						this.sessionId,
						write.row.id,
						seq,
						write.row.entryId ?? null,
						write.row.adjustment,
						jsonValue(write.row.usage),
						write.row.details === undefined ? null : jsonValue(write.row.details),
					],
				);
				return;
			case "value":
				if (write.op === "delete") {
					await transaction.query(
						"DELETE FROM pi_poc_storage_values WHERE session_id = $1 AND namespace = $2 AND value_key = $3",
						[this.sessionId, write.namespace, write.key],
					);
				} else {
					await transaction.query(
						`INSERT INTO pi_poc_storage_values (session_id, namespace, value_key, seq, value)
						 VALUES ($1, $2, $3, $4, $5::jsonb)
						 ON CONFLICT (session_id, namespace, value_key)
						 DO UPDATE SET seq = EXCLUDED.seq, value = EXCLUDED.value`,
						[this.sessionId, write.namespace, write.key, seq, jsonValue(write.value)],
					);
				}
				return;
			case "list":
				if (write.op === "delete") {
					await transaction.query(
						"DELETE FROM pi_poc_storage_lists WHERE session_id = $1 AND namespace = $2 AND list_key = $3",
						[this.sessionId, write.namespace, write.key],
					);
				} else {
					await transaction.query(
						`INSERT INTO pi_poc_storage_lists (session_id, namespace, list_key, seq, value)
						 VALUES ($1, $2, $3, $4, $5::jsonb)`,
						[this.sessionId, write.namespace, write.key, seq, jsonValue(write.value)],
					);
				}
				return;
		}
	}

	async getEntries(ids: string[], _context: Context): Promise<Map<string, Entry>> {
		this.assertOpen();
		if (ids.length === 0) return new Map();
		const result = await this.executor.query<EntryRow>(
			"SELECT id, parent_id, seq, timestamp_ms, entry_type, custom_type, payload FROM pi_poc_storage_entries WHERE session_id = $1 AND id = ANY($2::text[])",
			[this.sessionId, ids],
		);
		const found = new Map(result.rows.map((row) => [row.id, entryFromRow(row)]));
		return new Map(ids.flatMap((id) => {
			const entry = found.get(id);
			return entry === undefined ? [] : [[id, entry] as const];
		}));
	}

	async getValue<T>(address: Value<T>, _context: Context): Promise<StoredValue<T> | undefined> {
		this.assertOpen();
		const result = await this.executor.query<ValueRow>(
			"SELECT namespace, value_key, seq, value FROM pi_poc_storage_values WHERE session_id = $1 AND namespace = $2 AND value_key = $3",
			[this.sessionId, address.namespace, address.key],
		);
		const row = result.rows[0];
		return row === undefined
			? undefined
			: { address, value: rowJson<T>(row.value), seq: numberValue(row.seq) };
	}

	async scanValues<T>(prefix: Value<T>, _context: Context): Promise<StoredValue<T>[]> {
		this.assertOpen();
		const result = await this.executor.query<ValueRow>(
			"SELECT namespace, value_key, seq, value FROM pi_poc_storage_values WHERE session_id = $1 AND namespace = $2",
			[this.sessionId, prefix.namespace],
		);
		return result.rows
			.filter((row) => row.value_key.startsWith(prefix.key))
			.sort((left, right) => codePointCompare(left.value_key, right.value_key))
			.map((row) => ({
				address: { namespace: row.namespace, key: row.value_key, kind: "value" } as Value<T>,
				value: rowJson<T>(row.value),
				seq: numberValue(row.seq),
			}));
	}

	async readList<T>(address: ValueList<T>, options: ListReadOptions | undefined, _context: Context): Promise<ListElement<T>[]> {
		this.assertOpen();
		const resolved = resolveListReadOptions(options);
		const clauses = ["session_id = $1", "namespace = $2", "list_key = $3"];
		const values: unknown[] = [this.sessionId, address.namespace, address.key];
		if (resolved.cursor !== undefined) {
			values.push(resolved.cursor.seq);
			clauses.push(`seq ${resolved.order === "asc" ? ">" : "<"} $${values.length}`);
		}
		values.push(resolved.limit);
		const result = await this.executor.query<ListRow>(
			`SELECT seq, value FROM pi_poc_storage_lists WHERE ${clauses.join(" AND ")} ORDER BY seq ${resolved.order === "asc" ? "ASC" : "DESC"} LIMIT $${values.length}`,
			values,
		);
		return result.rows.map((row) => ({ seq: numberValue(row.seq), value: rowJson<T>(row.value) }));
	}

	async scanBranch(query: StorageBranchScan, _context: Context): Promise<Entry[]> {
		this.assertOpen();
		const entries = await this.loadBranch(query.start, _context);
		if (query.order === "oldestFirst") entries.reverse();
		const stopped: Entry[] = [];
		for (const entry of entries) {
			stopped.push(entry);
			if (entry.id === query.stopAtId || entry.type === query.stopAtType) break;
		}
		const filtered = stopped
			.filter((entry) => query.type === undefined || entry.type === query.type)
			.filter((entry) => query.customType === undefined || entry.customType === query.customType)
			.filter((entry) => query.cursor === undefined || (query.order === "oldestFirst" ? entry.seq > query.cursor.seq : entry.seq < query.cursor.seq));
		return query.limit === undefined ? filtered : filtered.slice(0, Math.max(0, query.limit));
	}

	async scanBranchStructure(query: StorageBranchScan, context: Context): Promise<EntryStructure[]> {
		return (await this.scanBranch(query, context)).map(entryStructure);
	}

	async scanEntries(query: EntryScan, _context: Context): Promise<Entry[]> {
		this.assertOpen();
		const clauses = ["session_id = $1"];
		const values: unknown[] = [this.sessionId];
		if (query.type !== undefined) {
			values.push(query.type);
			clauses.push(`entry_type = $${values.length}`);
		}
		if (query.customType !== undefined) {
			values.push(query.customType);
			clauses.push(`custom_type = $${values.length}`);
		}
		if (query.fromSeq !== undefined) {
			values.push(query.fromSeq);
			clauses.push(`seq >= $${values.length}`);
		}
		if (query.toSeq !== undefined) {
			values.push(query.toSeq);
			clauses.push(`seq <= $${values.length}`);
		}
		const limit = pageLimit(query.limit);
		if (limit !== Number.POSITIVE_INFINITY) {
			values.push(limit);
		}
		const order = query.order === "desc" ? "DESC" : "ASC";
		const limitClause = limit === Number.POSITIVE_INFINITY ? "" : ` LIMIT $${values.length}`;
		const result = await this.executor.query<EntryRow>(
			`SELECT id, parent_id, seq, timestamp_ms, entry_type, custom_type, payload
			 FROM pi_poc_storage_entries WHERE ${clauses.join(" AND ")} ORDER BY seq ${order}${limitClause}`,
			values,
		);
		return result.rows.map(entryFromRow);
	}

	async scanUsage(query: UsageScan, _context: Context): Promise<UsageRow[]> {
		this.assertOpen();
		const clauses = ["session_id = $1"];
		const values: unknown[] = [this.sessionId];
		if (query.fromSeq !== undefined) {
			values.push(query.fromSeq);
			clauses.push(`seq >= $${values.length}`);
		}
		if (query.toSeq !== undefined) {
			values.push(query.toSeq);
			clauses.push(`seq <= $${values.length}`);
		}
		const limit = pageLimit(query.limit);
		if (limit !== Number.POSITIVE_INFINITY) values.push(limit);
		const order = query.order === "desc" ? "DESC" : "ASC";
		const limitClause = limit === Number.POSITIVE_INFINITY ? "" : ` LIMIT $${values.length}`;
		const result = await this.executor.query<UsageRowData>(
			`SELECT id, seq, entry_id, adjustment, usage, details
			 FROM pi_poc_storage_usage WHERE ${clauses.join(" AND ")} ORDER BY seq ${order}${limitClause}`,
			values,
		);
		return result.rows.map((row) => ({
			id: row.id,
			seq: numberValue(row.seq),
			...(row.entry_id === null ? {} : { entryId: row.entry_id }),
			adjustment: row.adjustment,
			usage: row.usage,
			...(row.details === null ? {} : { details: row.details }),
		}));
	}

	async getStats(_context: Context): Promise<SessionStats> {
		this.assertOpen();
		return this.getStatsWith(this.executor);
	}

	private async getStatsWith(executor: SqlExecutor): Promise<SessionStats> {
		const messages = await executor.query<{ count: string }>(
			"SELECT COUNT(*)::text AS count FROM pi_poc_storage_entries WHERE session_id = $1 AND entry_type = 'message'",
			[this.sessionId],
		);
		const usage = await executor.query<{ usage: Usage }>(
			"SELECT usage FROM pi_poc_storage_usage WHERE session_id = $1 ORDER BY seq ASC",
			[this.sessionId],
		);
		return {
			messageCount: Number(messages.rows[0]?.count ?? 0),
			usage: usage.rows.reduce((total, row) => addUsage(total, row.usage), emptyUsage()),
		};
	}

	private async loadBranch(startId: string, context: Context): Promise<Entry[]> {
		const path: Entry[] = [];
		let currentId: string | null = startId;
		while (currentId !== null) {
			const entries = await this.getEntries([currentId], context);
			const entry = entries.get(currentId);
			if (entry === undefined) throw new Error(`Unknown branch start: ${startId}`);
			path.push(entry);
			currentId = entry.parentId;
		}
		return path;
	}

	async close(_context: Context): Promise<void> {
		if (this.closePromise !== undefined) return this.closePromise;
		this.state = "closing";
		this.closePromise = this.commitQueue.then(() => {
			this.state = "closed";
		});
		return this.closePromise;
	}

	private assertOpen(): void {
		if (this.state !== "open") throw new Error("PostgresStorage is closed");
	}
}
