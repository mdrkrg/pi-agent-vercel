import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FunctionService } from "../packages/agent-runtime/src/index.ts";
import { PgExecutor, SessionForkConflictError } from "../packages/pi-postgres/src/index.ts";

const source = { id: "source/id", createdAt: 1, storageVersion: 1 };
const destination = { id: "fork", createdAt: 2, storageVersion: 1, parentSessionId: source.id };
const principal = { userId: "owner", tenantId: "tenant", scopes: ["agent:run"] };

describe("authenticated Function fork HTTP contract (no database)", () => {
	const services: FunctionService[] = [];
	afterEach(async () => { for (const service of services.splice(0)) await service.close(); vi.restoreAllMocks(); });
	function fixture(scopes = principal.scopes) {
		const faux = fauxProvider();
		const service = new FunctionService({ executor: new PgExecutor({ connectionString: "postgres://unused" }), models: createModels(), model: faux.getModel(), apiToken: "api", cronSecret: "cron", principal: { ...principal, scopes } });
		services.push(service);
		const ready = vi.spyOn(service, "ready").mockResolvedValue();
		const authorize = vi.spyOn(service.repo, "authorizedMetadata").mockResolvedValue(source);
		const close = vi.fn().mockResolvedValue(undefined);
		const fork = vi.spyOn(service.repo, "forkWithOwner").mockResolvedValue({ metadata: destination, close } as unknown as Awaited<ReturnType<typeof service.repo.forkWithOwner>>);
		return { service, ready, authorize, fork, close };
	}
	async function invoke(service: FunctionService, input: unknown, token: string | null = "api", path = "/api/sessions/source%2Fid/fork", raw?: string) {
		const req = Object.assign(Readable.from(raw === undefined ? [] : [raw]), { method: "POST", url: path, ...(raw === undefined ? { body: input } : {}), headers: { ...(token === null ? {} : { authorization: `Bearer ${token}` }), "x-user-id": "attacker", "x-tenant-id": "other", "x-scopes": "agent:run" } });
		let status = 0; let output: unknown;
		const headers: Record<string, string> = {};
		const res = { set statusCode(value: number) { status = value; }, setHeader(name: string, value: string) { headers[name] = value; }, end(value: string) { output = JSON.parse(value); } };
		await service.handle(req as unknown as IncomingMessage, res as unknown as ServerResponse);
		return { status, body: output, headers };
	}

	it.each([
		{ scope: "tree" }, { scope: "tree", id: "chosen" },
		{ scope: "branch", branch: "main" },
		{ scope: "branch", branch: "main", entryId: "entry-1", position: "before", id: "chosen" },
		{ scope: "branch", branch: "main", entryId: "entry-1", position: "at" },
	])("passes validated options and configured owner: %j", async (input) => {
		const f = fixture();
		expect(await invoke(f.service, input)).toMatchObject({ status: 201, body: { session: destination }, headers: { "cache-control": "no-store" } });
		expect(f.authorize).toHaveBeenCalledWith(source.id, principal.userId, principal.tenantId);
		expect(f.fork).toHaveBeenCalledWith(source, input, principal, expect.anything());
		expect(f.close).toHaveBeenCalledOnce();
	});

	it.each([{}, { scope: "bad" }, { scope: "tree", id: "" }, { scope: "tree", id: 1 }, { scope: "tree", branch: "main" }, { scope: "tree", position: "after" }, { scope: "branch" }, { scope: "branch", branch: "" }, { scope: "branch", branch: 1 }, { scope: "branch", branch: "main", entryId: "" }, { scope: "branch", branch: "main", entryId: null }, { scope: "branch", branch: "main", position: "after" }, { scope: "branch", branch: "main", position: null }, null, []].map((input) => [input]))("rejects invalid input without forking: %j", async (input) => {
		const f = fixture(); expect((await invoke(f.service, input)).status).toBe(400); expect(f.fork).not.toHaveBeenCalled();
	});

	it("validates streamed JSON and path encoding", async () => {
		const f = fixture();
		expect((await invoke(f.service, undefined, "api", undefined, '{"scope":"tree"}')).status).toBe(201);
		expect((await invoke(f.service, undefined, "api", undefined, "{")).status).toBe(400);
		expect((await invoke(f.service, { scope: "tree" }, "api", "/api/sessions/%zz/fork")).status).toBe(400);
	});
	it.each([null, "wrong", "cron"])("rejects missing/wrong API token: %s", async (token) => {
		const f = fixture();
		const result = await invoke(f.service, { scope: "tree" }, token);
		expect(result.status).toBe(401); expect(f.ready).not.toHaveBeenCalled(); expect(f.fork).not.toHaveBeenCalled();
	});
	it("does not let identity headers grant the run scope", async () => {
		const f = fixture([]); expect((await invoke(f.service, { scope: "tree" })).status).toBe(403); expect(f.authorize).not.toHaveBeenCalled();
	});
	it("hides unauthorized/missing sources before body validation", async () => {
		const f = fixture(); f.authorize.mockResolvedValue(undefined);
		expect(await invoke(f.service, { scope: "bad" })).toMatchObject({ status: 404, body: { error: "Session not found" } }); expect(f.fork).not.toHaveBeenCalled();
	});
	it.each([
		[new SessionForkConflictError("fork"), 409],
		[new Error("Unknown source branch: missing"), 400],
		[new Error('Fork entry missing is not on source branch "main"'), 400],
		[new Error('Source branch "data" is not a configured AgentLane'), 400],
		[new Error("owner insert failed"), 500],
	])("maps fork failures without returning success: %s", async (error, status) => {
		const f = fixture(); f.fork.mockRejectedValue(error); expect((await invoke(f.service, { scope: "tree" })).status).toBe(status); expect(f.close).not.toHaveBeenCalled();
	});
});
