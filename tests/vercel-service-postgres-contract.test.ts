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
});
