import { Readable } from "node:stream";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { handleRequest, HttpError, type AgentService } from "../apps/vercel-service/src/service.ts";

class TestRequest extends Readable {
	method: string;
	url: string;
	headers: IncomingHttpHeaders;

	constructor(method: string, url: string, body?: unknown, headers: IncomingHttpHeaders = {}) {
		super({
			read() {
				this.push(body === undefined ? null : JSON.stringify(body));
				this.push(null);
			},
		});
		this.method = method;
		this.url = url;
		this.headers = headers;
	}
}

function response(): { response: ServerResponse; status: number; body: unknown; headers: Record<string, string> } {
	let status = 0;
	let body: unknown;
	const headers: Record<string, string> = {};
	const target = {
		get statusCode() { return status; },
		set statusCode(value: number) { status = value; },
		setHeader(name: string, value: string) { headers[name] = value; },
		end(value?: string) { body = value === undefined ? undefined : JSON.parse(value); },
	};
	return { response: target as unknown as ServerResponse, get status() { return status; }, get body() { return body; }, headers };
}

type ServiceRequest = Parameters<typeof handleRequest>[0];

function request(method: string, url: string, body?: unknown, headers: IncomingHttpHeaders = {}): ServiceRequest {
	return new TestRequest(method, url, body, headers) as unknown as ServiceRequest;
}

function service(overrides: Partial<AgentService>): AgentService {
	return { mode: "local", ...overrides } as AgentService;
}

const submission = {
	id: "submission-1",
	userId: "local-user",
	tenantId: "local-tenant",
	sessionId: "session-1",
	clientRequestId: "request-1",
	requestHash: "hash",
	operationId: "operation-1",
	status: "running" as const,
	resultRef: null,
	errorCode: null,
	createdAt: 1,
	updatedAt: 1,
};

describe("local Vercel service HTTP contract", () => {
	it("serves health without constructing a database service", async () => {
		const output = response();
		await handleRequest(request("GET", "/api/health"), output.response);
		expect(output.status).toBe(200);
		expect(output.body).toEqual({ ok: true, mode: "local" });
	});

	it("requires a non-empty prompt and idempotency key before admission", async () => {
		let admitted = false;
		const output = response();
		await handleRequest(
			request("POST", "/api/sessions/session-1/messages", { content: "" }),
			output.response,
			service({ submit: async () => { admitted = true; return submission; } }),
		);
		expect(output.status).toBe(400);
		expect(admitted).toBe(false);

		const second = response();
		await handleRequest(
			request("POST", "/api/sessions/session-1/messages", { content: "hello" }),
			second.response,
			service({ submit: async () => { admitted = true; return submission; } }),
		);
		expect(second.status).toBe(400);
		expect(admitted).toBe(false);
	});

	it("passes identity and content to the admission service", async () => {
		let received: unknown[] = [];
		const output = response();
		await handleRequest(
			request("POST", "/api/sessions/session-1/messages", { content: "hello" }, {
				"idempotency-key": "request-1",
				"x-user-id": "user-1",
				"x-tenant-id": "tenant-1",
				"x-scopes": "agent:run",
			}),
			output.response,
			service({ submit: async (...args) => { received = args; return submission; } }),
		);
		expect(output.status).toBe(202);
		expect(received.slice(0, 2)).toEqual(["session-1", "hello"]);
		expect(received[2]).toMatchObject({ userId: "user-1", tenantId: "tenant-1", scopes: ["agent:run"] });
		expect(received[3]).toBe("request-1");
	});

	it("protects the internal drive endpoint with the workflow token", async () => {
		let driven = false;
		const output = response();
		await handleRequest(
			request("POST", "/api/internal/agent-drive", { submissionId: "s", sessionId: "ss", operationId: "o" }),
			output.response,
			service({ authorizeWorkflow: async () => { throw new HttpError(401, "invalid"); }, driveInternal: async () => { driven = true; return { kind: "completed" }; } }),
		);
		expect(output.status).toBe(401);
		expect(driven).toBe(false);
	});
});
