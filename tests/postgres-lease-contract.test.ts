import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core/harness/context";
import { setValue, value } from "@earendil-works/pi-agent-core/harness/session";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	deletePiPostgresSession,
	ensurePiPostgresSchema,
	PgExecutor,
	PostgresStorage,
	SessionLeaseBusyError,
	SessionLeaseLostError,
	SessionLeaseManager,
} from "../packages/pi-postgres/src/index.ts";

const databaseUrl = process.env.DATABASE_URL;

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

describe.skipIf(databaseUrl === undefined)("Postgres session lease contract", () => {
	const executor = new PgExecutor({ connectionString: databaseUrl });

	beforeAll(async () => {
		await ensurePiPostgresSchema(executor);
	});

	afterAll(async () => {
		await executor.query("DELETE FROM agent_session_leases");
		await executor.close();
	});

	it("admits one owner and rejects a concurrent owner", async () => {
		const sessionId = `lease-${randomUUID()}`;
		const manager = new SessionLeaseManager(executor);
		try {
			const results = await Promise.allSettled([
				manager.acquire(sessionId, { holderId: "owner-a", ttlMs: 1_000 }),
				manager.acquire(sessionId, { holderId: "owner-b", ttlMs: 1_000 }),
			]);
			expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
			const rejected = results.find((result) => result.status === "rejected");
			expect(rejected?.status === "rejected" ? rejected.reason : undefined).toBeInstanceOf(SessionLeaseBusyError);
		} finally {
			await executor.query("DELETE FROM agent_session_leases WHERE session_id = $1", [sessionId]);
		}
	});

	it("increments fencing epoch after expiry", async () => {
		const sessionId = `lease-${randomUUID()}`;
		const manager = new SessionLeaseManager(executor);
		try {
			const first = await manager.acquire(sessionId, { holderId: "owner-a", ttlMs: 20 });
			await delay(80);
			const second = await manager.acquire(sessionId, { holderId: "owner-b", ttlMs: 1_000 });
			expect(second.fencingEpoch).toBe(first.fencingEpoch + 1);
			await expect(manager.renew(first)).rejects.toBeInstanceOf(SessionLeaseLostError);
			await manager.release(second);
		} finally {
			await executor.query("DELETE FROM agent_session_leases WHERE session_id = $1", [sessionId]);
		}
	});

	it("rejects a stale storage writer", async () => {
		const sessionId = `lease-${randomUUID()}`;
		const manager = new SessionLeaseManager(executor);
		try {
			const first = await manager.acquire(sessionId, { holderId: "owner-a", ttlMs: 20 });
			await delay(80);
			const second = await manager.acquire(sessionId, { holderId: "owner-b", ttlMs: 1_000 });
			const storage = new PostgresStorage(executor, sessionId, Date.now, first);
			await expect(storage.commit([setValue(value("lease", "stale"), "should-fail")], BACKGROUND_CONTEXT)).rejects.toBeInstanceOf(SessionLeaseLostError);
			await storage.close(BACKGROUND_CONTEXT);
			await manager.release(second);
		} finally {
			await deletePiPostgresSession(executor, sessionId);
		}
	});

	it("preserves fencing epochs after release even when a holder id is reused", async () => {
		const sessionId = `lease-${randomUUID()}`;
		const manager = new SessionLeaseManager(executor);
		const first = await manager.acquire(sessionId, { holderId: "reused-owner" });
		await manager.release(first);
		const second = await manager.acquire(sessionId, { holderId: "reused-owner" });
		const staleStorage = new PostgresStorage(executor, sessionId, Date.now, first);
		try {
			expect(second.fencingEpoch).toBeGreaterThan(first.fencingEpoch);
			await manager.release(first);
			await expect(manager.renew(second)).resolves.toMatchObject({ fencingEpoch: second.fencingEpoch });
			await expect(staleStorage.commit([setValue(value("lease", "stale"), "should-fail")], BACKGROUND_CONTEXT)).rejects.toBeInstanceOf(SessionLeaseLostError);
		} finally {
			await staleStorage.close(BACKGROUND_CONTEXT);
			await deletePiPostgresSession(executor, sessionId);
		}
	});
});
