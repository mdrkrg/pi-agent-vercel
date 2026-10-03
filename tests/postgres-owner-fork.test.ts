import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/pi-agent-core/harness/context";
import { appendList, list, setValue, value } from "@earendil-works/pi-agent-core/harness/session";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { deletePiPostgresSession, ensurePiPostgresSchema, PgExecutor, PostgresSessionRepo, PostgresStorage, SessionForkConflictError, type SqlExecutor } from "../packages/pi-postgres/src/index.ts";

const databaseUrl = process.env.DATABASE_URL;
const owner = { userId: "fork-owner", tenantId: "fork-tenant" };
const address = value<string>("app.fork", "value");
const items = list<string>("app.fork", "list");
const tables = ["pi_poc_sessions", "agent_session_access", "pi_poc_storage_entries", "pi_poc_storage_values", "pi_poc_storage_lists", "pi_poc_storage_usage", "pi_poc_storage_sequences"];
function signal() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }
/** Gate real SQL without weakening its transaction or isolation semantics. */
function observed(executor: SqlExecutor, after: (text: string, values: readonly unknown[]) => Promise<void>): SqlExecutor {
	return {
		async query<Row extends object>(text: string, values: readonly unknown[] = []) {
			const result = await executor.query<Row>(text, values); await after(text, values); return result;
		},
		transaction: (callback) => executor.transaction((tx) => callback(observed(tx, after))),
	};
}

describe.skipIf(databaseUrl === undefined)("atomic owner-aware PostgreSQL fork", () => {
	const executor = new PgExecutor({ connectionString: databaseUrl, max: 4 });
	const repos: PostgresSessionRepo[] = []; const ids: string[] = [];
	beforeAll(async () => ensurePiPostgresSchema(executor));
	afterEach(async () => { for (const repo of repos.splice(0)) await repo.close(ctx); for (const id of ids.splice(0)) await deletePiPostgresSession(executor, id); });
	afterAll(async () => executor.close());
	function repo(sql: SqlExecutor = executor) { const result = new PostgresSessionRepo(sql); repos.push(result); return result; }
	function id() { const result = `owner-fork-${randomUUID()}`; ids.push(result); return result; }
	async function seed(repository: PostgresSessionRepo) {
		const source = await repository.createWithOwner(owner, ctx); ids.push(source.metadata.id);
		const branch = await source.createBranch("data", null, ctx);
		await branch.appendCustomEntry("first", {}, ctx); await branch.appendCustomEntry("second", {}, ctx);
		await source.mutate((m) => m.commit([setValue(address, "old"), appendList(items, "old")], ctx), ctx);
		return source;
	}
	async function absent(destination: string) {
		for (const table of tables) {
			const key = table === "pi_poc_sessions" ? "id" : "session_id";
			expect((await executor.query(`SELECT * FROM ${table} WHERE ${key}=$1`, [destination])).rows, table).toEqual([]);
		}
	}

	it("commits ownership, parent, storage and sequence high-water mark together", async () => {
		const destination = id(); const inserted = signal(); const release = signal();
		const repository = repo(observed(executor, async (text, values) => {
			if (text.includes("INSERT INTO agent_session_access") && values[0] === destination) { inserted.resolve(); await release.promise; }
		}));
		const source = await seed(repository);
		const forking = repository.forkWithOwner(source.metadata, { scope: "tree", id: destination }, owner, ctx);
		try { await inserted.promise; await absent(destination); }
		finally { release.resolve(); }
		const fork = await forking;
		expect(await repo().authorizedMetadata(destination, owner.userId, owner.tenantId)).toEqual(fork.metadata);
		expect(fork.metadata.parentSessionId).toBe(source.metadata.id);
		expect(await fork.findEntries(undefined, ctx)).toHaveLength(2);
		expect((await fork.getValue(address, ctx))?.value).toBe("old");
		expect((await fork.readList(items, undefined, ctx)).map((item) => item.value)).toEqual(["old"]);
		const sequence = await executor.query("SELECT next_seq FROM pi_poc_storage_sequences WHERE session_id=$1", [source.metadata.id]);
		expect((await executor.query("SELECT next_seq FROM pi_poc_storage_sequences WHERE session_id=$1", [destination])).rows).toEqual(sequence.rows);
		await fork.setValue(address, "new", ctx);
		expect((await fork.getValue(address, ctx))?.seq).toBe(Number(sequence.rows[0]!.next_seq));
		await expect(repository.forkWithOwner(source.metadata, { scope: "tree", id: destination }, owner, ctx)).rejects.toBeInstanceOf(SessionForkConflictError);
		await fork.close(ctx);
		await expect(repository.forkWithOwner(source.metadata, { scope: "tree", id: destination }, owner, ctx)).rejects.toBeInstanceOf(SessionForkConflictError);
	});

	it("rolls back every copied table on ownership trigger failure and releases the destination id", async () => {
		const repository = repo(); const source = await seed(repository); const destination = id();
		await executor.query("CREATE FUNCTION reject_owner_fork() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.user_id='reject-fork-owner' THEN RAISE EXCEPTION 'fork owner rejected'; END IF; RETURN NEW; END $$");
		await executor.query("CREATE TRIGGER reject_owner_fork BEFORE INSERT ON agent_session_access FOR EACH ROW EXECUTE FUNCTION reject_owner_fork()");
		try {
			await expect(repository.forkWithOwner(source.metadata, { scope: "tree", id: destination }, { ...owner, userId: "reject-fork-owner" }, ctx)).rejects.toThrow("fork owner rejected");
			await absent(destination);
			expect(await source.findEntries(undefined, ctx)).toHaveLength(2);
			const retry = await repository.forkWithOwner(source.metadata, { scope: "tree", id: destination }, owner, ctx);
			expect(retry.metadata.id).toBe(destination);
		} finally {
			await executor.query("DROP TRIGGER reject_owner_fork ON agent_session_access"); await executor.query("DROP FUNCTION reject_owner_fork()");
		}
	});

	it.each([{ userId: "", tenantId: "t" }, { userId: "u", tenantId: "" }])("rejects empty owner before writes: %j", async (invalid) => {
		const repository = repo(); const source = await seed(repository); const destination = id();
		await expect(repository.forkWithOwner(source.metadata, { scope: "tree", id: destination }, invalid, ctx)).rejects.toThrow("must not be empty");
		await absent(destination);
	});

	it("drains an admitted local source commit before taking the fork snapshot", async () => {
		const entered = signal(); const release = signal(); let armed = false;
		// Park the admitted storage commit before BEGIN: request-time schema DDL
		// must not block behind a transaction already holding storage write locks.
		const repository = repo({
			query: executor.query.bind(executor),
			async transaction(callback) {
				if (armed) { armed = false; entered.resolve(); await release.promise; }
				return executor.transaction(callback);
			},
		});
		const source = await seed(repository); const destination = id(); armed = true;
		const mutation = await source.beginMutation(ctx);
		const commit = mutation.commit([setValue(address, "committing")], ctx);
		const draining = signal(); const whenIdle = PostgresStorage.prototype.whenIdle;
		const idleSpy = vi.spyOn(PostgresStorage.prototype, "whenIdle").mockImplementation(function (this: PostgresStorage) {
			draining.resolve(); return whenIdle.call(this);
		});
		let forkPromise: ReturnType<PostgresSessionRepo["forkWithOwner"]> | undefined;
		try {
			await entered.promise;
			forkPromise = repository.forkWithOwner(source.metadata, { scope: "tree", id: destination }, owner, ctx);
			await draining.promise;
			await absent(destination);
			release.resolve(); await commit;
			const fork = await forkPromise;
			expect((await fork.getValue(address, ctx))?.value).toBe("committing");
		} finally { release.resolve(); await commit; await mutation.end(ctx); if (forkPromise !== undefined) await forkPromise; idleSpy.mockRestore(); }
	});

	it("keeps one repeatable-read snapshot while another repository commits source changes", async () => {
		const entered = signal(); const release = signal(); let armed = false;
		const repository = repo(observed(executor, async (text) => {
			if (armed && text.includes("FROM pi_poc_storage_entries WHERE session_id")) { armed = false; entered.resolve(); await release.promise; }
		}));
		const source = await seed(repository); await source.close(ctx); const destination = id();
		const writer = await repo().open(source.metadata, ctx);
		const oldSequence = (await executor.query("SELECT next_seq FROM pi_poc_storage_sequences WHERE session_id=$1", [source.metadata.id])).rows;
		armed = true;
		const forking = repository.forkWithOwner(source.metadata, { scope: "tree", id: destination }, owner, ctx);
		try {
			await entered.promise;
			const branch = await writer.branch("data", ctx); await branch!.appendCustomEntry("later", {}, ctx);
			await writer.mutate((m) => m.commit([setValue(address, "new"), appendList(items, "new")], ctx), ctx);
			release.resolve(); const fork = await forking;
			expect(await fork.findEntries(undefined, ctx)).toHaveLength(2);
			expect((await fork.getValue(address, ctx))?.value).toBe("old");
			expect((await fork.readList(items, undefined, ctx)).map((item) => item.value)).toEqual(["old"]);
			expect((await executor.query("SELECT next_seq FROM pi_poc_storage_sequences WHERE session_id=$1", [destination])).rows).toEqual(oldSequence);
			expect(await repository.authorizedMetadata(destination, owner.userId, owner.tenantId)).toEqual(fork.metadata);
		} finally { release.resolve(); await forking; }
	});
});
