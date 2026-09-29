import { uuidv7 } from "@earendil-works/pi-agent-core";
import {
	StorageBackedSession,
	type Session,
	type SessionCreateOptions,
	type SessionMetadata,
	type SessionRepo,
	type ForkOptions,
} from "@earendil-works/pi-agent-core/harness/session";
import type { Context } from "@earendil-works/pi-agent-core/harness/context";
import { deletePiPostgresSession, ensurePiPostgresSchema } from "./schema.ts";
import { PostgresStorage } from "./storage.ts";
import type { SqlExecutor } from "./sql.ts";
import type { SessionLease } from "./lease.ts";

const STORAGE_VERSION = 1;

type SessionRow = {
	id: string;
	created_at: string | number;
	storage_version: number;
	parent_session_id: string | null;
};

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

	private async createInternal(options: SessionCreateOptions, lease: SessionLease | undefined, context: Context): Promise<Session> {
		this.assertOpen();
		const id = options.id ?? uuidv7(this.now());
		if (this.openSessions.has(id) || this.pendingCreates.has(id)) throw new Error(`Session already open: ${id}`);
		this.pendingCreates.add(id);
		const createdAt = this.now();
		try {
			await ensurePiPostgresSchema(this.executor);
			await this.executor.transaction(async (transaction) => {
				await transaction.query(
					`INSERT INTO pi_poc_sessions (id, created_at, storage_version, parent_session_id)
					 VALUES ($1, $2, $3, $4)`,
					[id, createdAt, STORAGE_VERSION, options.parentSessionId ?? null],
				);
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

	async delete(metadata: SessionMetadata, _context: Context): Promise<void> {
		this.assertOpen();
		if (this.openSessions.has(metadata.id)) throw new Error(`Session is open: ${metadata.id}`);
		const result = await this.executor.query<{ id: string }>("SELECT id FROM pi_poc_sessions WHERE id = $1", [metadata.id]);
		if (result.rows.length === 0) throw new Error(`Unknown session: ${metadata.id}`);
		await deletePiPostgresSession(this.executor, metadata.id);
	}

	fork(_source: SessionMetadata, _options: ForkOptions, _context: Context): Promise<Session> {
		return Promise.reject(new Error("PostgresSessionRepo fork is not implemented in the PoC"));
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
			onClose: () => this.openSessions.delete(metadata.id),
		});
		this.openSessions.set(metadata.id, session);
		return session;
	}

	private assertOpen(): void {
		if (this.closed) throw new Error("PostgresSessionRepo is closed");
	}
}
