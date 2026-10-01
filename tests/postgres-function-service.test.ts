import { Readable, Writable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core/harness/context";
import type { AgentHarnessTool } from "@earendil-works/pi-agent-core";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { FunctionService, type ServiceToolContext } from "../packages/agent-runtime/src/index.ts";
import { deletePiPostgresSession, ensurePiPostgresSchema, PgExecutor, PostgresSessionRepo } from "../packages/pi-postgres/src/index.ts";

const databaseUrl = process.env.DATABASE_URL;
class Response extends Writable {
	statusCode = 200; readonly headers = new Map<string, string>(); data = "";
	setHeader(name: string, value: string) { this.headers.set(name, value); }
	_write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) { this.data += chunk.toString(); callback(); }
}
describe.skipIf(databaseUrl === undefined)("Function service durable composition", () => {
	const executor = new PgExecutor({ connectionString: databaseUrl }); const sessions: string[] = [];
	const toolContexts: ServiceToolContext[] = [];
	beforeAll(async () => ensurePiPostgresSchema(executor));
	afterEach(async () => { for (const id of sessions.splice(0)) await deletePiPostgresSession(executor, id); toolContexts.length = 0; });
	afterAll(async () => executor.close());

	async function invoke(path: string, options: { method?: string; body?: unknown; token?: string; key?: string; userId?: string } = {}) {
		const models = createModels(); const faux = fauxProvider(); models.setProvider(faux.provider);
		faux.setResponses([fauxAssistantMessage(fauxToolCall("whoami", {})), fauxAssistantMessage("final answer")]);
		const tool: AgentHarnessTool<ServiceToolContext> = {
			name: "whoami", label: "Who am I", description: "Return the durable user", parameters: { type: "object", properties: {} }, replay: "safe",
			execute: async (_id, _args, _update, context) => { toolContexts.push(context); return { content: [{ type: "text", text: context.principal.userId }], details: undefined }; },
		};
		const service = new FunctionService({ executor: new PgExecutor({ connectionString: databaseUrl, max: 4 }), models, model: faux.getModel(), tools: [tool], apiToken: "api-token", cronSecret: "cron-token", principal: { userId: options.userId ?? "u", tenantId: "t", scopes: ["agent:run"] } });
		const req = Object.assign(Readable.from([]), { url: path, method: options.method ?? "GET", body: options.body, headers: { authorization: `Bearer ${options.token ?? "api-token"}`, "idempotency-key": options.key, "x-user-id": "attacker" } });
		const res = new Response();
		try { await service.handle(req as unknown as IncomingMessage, res as unknown as ServerResponse); }
		finally { await service.close(); }
		return { status: res.statusCode, body: JSON.parse(res.data) };
	}

	it("a fresh authenticated worker completes persisted jobs and rebuilds tool context", async () => {
		const created = await invoke("/api/sessions", { method: "POST" }); expect(created.status).toBe(201);
		const id: string = created.body.session.id; sessions.push(id);
		const first = await invoke(`/api/sessions/${id}/messages`, { method: "POST", body: { prompt: "hello" }, key: "request" });
		const retry = await invoke(`/api/sessions/${id}/messages`, { method: "POST", body: { prompt: "hello" }, key: "request" });
		expect(first.status).toBe(202); expect(retry.body.submission.id).toBe(first.body.submission.id);
		expect(await invoke(`/api/sessions/${id}/messages`, { method: "POST", body: { prompt: "different" }, key: "request" })).toMatchObject({ status: 409 });
		const submissionId: string = first.body.submission.id;
		const rejectedWorker = await invoke("/api/worker"); expect(rejectedWorker.status).toBe(401);
		const worker = await invoke("/api/worker", { token: "cron-token" }); expect(worker.status).toBe(200);
		expect(worker.body.driven).toEqual([expect.objectContaining({ status: "completed", operationId: submissionId })]);
		expect(toolContexts).toEqual([expect.objectContaining({ principal: { userId: "u", tenantId: "t", scopes: ["agent:run"] }, operationId: submissionId, submissionId, sessionId: id })]);
		const view = await invoke(`/api/submissions/${submissionId}`); expect(view.body.submission.status).toBe("completed");
		const result = await invoke(`/api/submissions/${submissionId}/result`); expect(result.body.result.status).toBe("completed");
		expect(result.body.output.message.content[0].text).toBe("final answer");
		expect(await invoke(`/api/submissions/${submissionId}`, { userId: "other" })).toMatchObject({ status: 404 });
		expect(await invoke(`/api/sessions/${id}/messages`, { method: "POST", body: { prompt: "no" }, key: "other", userId: "other" })).toMatchObject({ status: 404 });
	});

	it("retains a second request while its lane is busy and admits it on a later tick", async () => {
		const created = await invoke("/api/sessions", { method: "POST" }); const id: string = created.body.session.id; sessions.push(id);
		await invoke(`/api/sessions/${id}/messages`, { method: "POST", body: { prompt: "one" }, key: "one" });
		const second = await invoke(`/api/sessions/${id}/messages`, { method: "POST", body: { prompt: "two" }, key: "two" });
		expect(second.body.submission.status).toBe("accepted");
		expect(await invoke(`/api/submissions/${second.body.submission.id}/result`)).toMatchObject({ status: 409 });
		await invoke("/api/worker", { token: "cron-token" });
		await invoke("/api/worker", { token: "cron-token" });
		expect((await invoke(`/api/submissions/${second.body.submission.id}`)).body.submission.status).toBe("completed");
		expect(toolContexts).toHaveLength(2);
	});

	it("rolls back session creation if its ownership insert fails", async () => {
		await executor.query("CREATE FUNCTION reject_poc_owner() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.user_id='rollback-user' THEN RAISE EXCEPTION 'owner insert failed'; END IF; RETURN NEW; END $$");
		await executor.query("CREATE TRIGGER reject_poc_owner BEFORE INSERT ON agent_session_access FOR EACH ROW EXECUTE FUNCTION reject_poc_owner()");
		const repo = new PostgresSessionRepo(executor);
		try {
			const before = await repo.list(undefined, BACKGROUND_CONTEXT);
			await expect(repo.createWithOwner({ userId: "rollback-user", tenantId: "t" }, BACKGROUND_CONTEXT)).rejects.toThrow("owner insert failed");
			expect(await repo.list(undefined, BACKGROUND_CONTEXT)).toEqual(before);
		} finally { await executor.query("DROP TRIGGER reject_poc_owner ON agent_session_access"); await executor.query("DROP FUNCTION reject_poc_owner()"); await repo.close(BACKGROUND_CONTEXT); }
	});
});
