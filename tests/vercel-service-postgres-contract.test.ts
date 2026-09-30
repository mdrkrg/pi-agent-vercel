import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentService } from "../apps/vercel-service/src/service.ts";
import { deletePiPostgresSession } from "../packages/pi-postgres/src/index.ts";

const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(databaseUrl === undefined)("Vercel service PostgreSQL boundary", () => {
	let service: AgentService;
	const sessionIds: string[] = [];

	beforeEach(async () => {
		service = new AgentService({ databaseUrl: databaseUrl!, mode: "local" });
		await service.ready();
	});

	afterEach(async () => {
		for (const sessionId of sessionIds.splice(0)) await deletePiPostgresSession(service.executor, sessionId);
		await service.close();
	});

	it("binds a service-created session to its principal", async () => {
		const owner = { userId: "owner", tenantId: "tenant", scopes: ["agent:run"] } as const;
		const other = { userId: "other", tenantId: "tenant", scopes: ["agent:run"] } as const;
		const session = await service.createSession(`service-session-${randomUUID()}`, owner);
		sessionIds.push(session.id);

		await expect(service.submit(session.id, "hello", other, "request-1")).rejects.toMatchObject({ status: 404 });
	});

	it("copies service ownership when forking a session", async () => {
		const owner = { userId: "owner", tenantId: "tenant", scopes: ["agent:run"] } as const;
		const other = { userId: "other", tenantId: "tenant", scopes: ["agent:run"] } as const;
		const source = await service.createSession(`fork-source-${randomUUID()}`, owner);
		const fork = await service.forkSession(source.id, owner, { scope: "tree" });
		sessionIds.push(source.id, fork.id);

		const access = await service.executor.query<{ user_id: string; tenant_id: string }>(
			"SELECT user_id, tenant_id FROM agent_service_session_access WHERE session_id = $1",
			[fork.id],
		);
		expect(access.rows[0]).toEqual({ user_id: "owner", tenant_id: "tenant" });
		await expect(service.submit(fork.id, "hello", other, "request-1")).rejects.toMatchObject({ status: 404 });
	});
});
