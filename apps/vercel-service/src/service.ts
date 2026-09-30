import type { IncomingMessage, ServerResponse } from "node:http";
import { createModels, fauxAssistantMessage, fauxProvider, type Api, type Model, type Models } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core/harness/context";
import type { ForkOptions, SessionMetadata } from "@earendil-works/pi-agent-core/harness/session";
import {
	admitSubmission,
	drivePostgresOperation,
	openAgentHarness,
	type Principal,
	type WorkflowState,
} from "@poc/agent-runtime";
import {
	ensurePiPostgresSchema,
	PgExecutor,
	PostgresSessionRepo,
	SessionLeaseManager,
	SubmissionRepo,
	type Submission,
} from "@poc/pi-postgres";

export type ServiceMode = "local" | "vercel";
export type ServiceConfig = {
	readonly mode?: ServiceMode;
	readonly databaseUrl?: string;
	readonly localResponse?: string;
	readonly workflowStartUrl?: string;
	readonly workflowToken?: string;
	readonly maxDrivePasses?: number;
};

export type DriveStepResult =
	| { readonly kind: "completed" }
	| { readonly kind: "waiting"; readonly notBefore?: number };

type ToolContext = {
	readonly principal: Principal;
	readonly sessionId: string;
	readonly submissionId: string;
	readonly operationId: string;
};

type JsonObject = Record<string, unknown>;
type SessionAccessRow = { user_id: string; tenant_id: string };
type VercelRequest = IncomingMessage & { readonly body?: unknown };

export class HttpError extends Error {
	constructor(readonly status: number, message: string) {
		super(message);
		this.name = "HttpError";
	}
}

function requiredEnv(name: string, value: string | undefined): string {
	if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
	return value;
}

function asHeader(value: string | string[] | undefined): string | undefined {
	return Array.isArray(value) ? value[0] : value;
}

function json(res: ServerResponse, status: number, value: unknown): void {
	const body = JSON.stringify(value);
	res.statusCode = status;
	res.setHeader("content-type", "application/json; charset=utf-8");
	res.setHeader("cache-control", "no-store");
	res.end(body);
}

async function readJson(req: VercelRequest): Promise<JsonObject> {
	if (req.body !== undefined) {
		if (req.body === null || typeof req.body !== "object" || Array.isArray(req.body)) throw new HttpError(400, "Request body must be a JSON object");
		return req.body as JsonObject;
	}
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buffer.length;
		if (size > 1_048_576) throw new HttpError(413, "Request body is too large");
		chunks.push(buffer);
	}
	if (chunks.length === 0) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new HttpError(400, "Request body must be valid JSON");
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new HttpError(400, "Request body must be a JSON object");
	return parsed as JsonObject;
}

function stringField(body: JsonObject, name: string): string {
	const value = body[name];
	if (typeof value !== "string" || value.length === 0) throw new HttpError(400, `${name} must be a non-empty string`);
	return value;
}

function optionalStringField(body: JsonObject, name: string): string | undefined {
	return body[name] === undefined ? undefined : stringField(body, name);
}

function forkOptions(body: JsonObject): ForkOptions {
	const id = optionalStringField(body, "id");
	const scope = body.scope;
	if (scope === "tree") return id === undefined ? { scope } : { scope, id };
	if (scope !== "branch") throw new HttpError(400, "scope must be branch or tree");
	const branch = stringField(body, "branch");
	const entryId = optionalStringField(body, "entryId");
	const position = body.position;
	if (position !== undefined && position !== "before" && position !== "at") throw new HttpError(400, "position must be before or at");
	return {
		scope,
		branch,
		...(entryId === undefined ? {} : { entryId }),
		...(position === undefined ? {} : { position }),
		...(id === undefined ? {} : { id }),
	};
}

function principalFromRequest(req: IncomingMessage, mode: ServiceMode): Principal {
	const userId = asHeader(req.headers["x-user-id"]);
	const tenantId = asHeader(req.headers["x-tenant-id"]);
	const scopes = asHeader(req.headers["x-scopes"]);
	if (userId === undefined || tenantId === undefined) {
		if (mode === "local") return { userId: "local-user", tenantId: "local-tenant", scopes: ["agent:run"] };
		throw new HttpError(401, "Authentication adapter is not configured");
	}
	return {
		userId,
		tenantId,
		scopes: scopes === undefined ? [] : scopes.split(",").map((scope) => scope.trim()).filter(Boolean),
	};
}

function requestPath(req: IncomingMessage): string {
	return new URL(req.url ?? "/", "http://localhost").pathname.replace(/\/+$/, "") || "/";
}

function sessionIdFromPath(path: string): string | undefined {
	const match = /^\/api\/sessions\/([^/]+)(?:\/messages)?$/.exec(path);
	return match === null ? undefined : decodeURIComponent(match[1]!);
}

function submissionPath(path: string): { id: string; action?: "result" | "cancel" } | undefined {
	const match = /^\/api\/submissions\/([^/]+)(?:\/(result|cancel))?$/.exec(path);
	if (match === null) return undefined;
	return { id: decodeURIComponent(match[1]!), ...(match[2] === undefined ? {} : { action: match[2] as "result" | "cancel" }) };
}

function createLocalModel(response: string): { models: Models; model: Model<Api> } {
	const models = createModels();
	const faux = fauxProvider();
	models.setProvider(faux.provider);
	faux.setResponses([fauxAssistantMessage(response)]);
	return { models, model: faux.getModel() as Model<Api> };
}

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Service composition shared by the local Vercel simulator and api/index.ts.
 * The local model is deliberate: it validates Function/Workflow/Storage wiring
 * without requiring an LLM key. Production should replace this factory.
 */
export class AgentService {
	readonly executor: PgExecutor;
	readonly repo: PostgresSessionRepo;
	readonly leases: SessionLeaseManager;
	readonly submissions: SubmissionRepo;
	readonly mode: ServiceMode;
	private readonly localResponse: string;
	private readonly workflowStartUrl: string | undefined;
	private readonly workflowToken: string | undefined;
	private readonly maxDrivePasses: number;
	private readonly activeWorkflows = new Map<string, Promise<void>>();
	private readyPromise: Promise<void> | undefined;

	constructor(config: ServiceConfig = {}) {
		this.mode = config.mode ?? (process.env.VERCEL === "1" ? "vercel" : "local");
		const databaseUrl = config.databaseUrl ?? process.env.DATABASE_URL;
		this.executor = new PgExecutor({
			connectionString: requiredEnv("DATABASE_URL", databaseUrl),
			max: Number(process.env.PG_POOL_MAX ?? 4),
			connectionTimeoutMillis: 5_000,
			idleTimeoutMillis: 10_000,
		});
		this.repo = new PostgresSessionRepo(this.executor);
		this.leases = new SessionLeaseManager(this.executor);
		this.submissions = new SubmissionRepo(this.executor);
		this.localResponse = config.localResponse ?? process.env.LOCAL_AGENT_RESPONSE ?? "local vercel response";
		this.workflowStartUrl = config.workflowStartUrl ?? process.env.WORKFLOW_START_URL;
		this.workflowToken = config.workflowToken ?? process.env.WORKFLOW_START_TOKEN;
		this.maxDrivePasses = config.maxDrivePasses ?? Number(process.env.AGENT_MAX_DRIVE_PASSES ?? 32);
	}

	async ready(): Promise<void> {
		this.readyPromise ??= ensurePiPostgresSchema(this.executor);
		return this.readyPromise;
	}

	async close(): Promise<void> {
		await Promise.allSettled([...this.activeWorkflows.values()]);
		await this.repo.close(BACKGROUND_CONTEXT);
		await this.executor.close();
	}

	async createSession(requestedId: string | undefined, principal: Principal): Promise<SessionMetadata> {
		await this.ready();
		const session = await this.repo.create({ ...(requestedId === undefined ? {} : { id: requestedId }) }, BACKGROUND_CONTEXT);
		try {
			const metadata = session.metadata;
			await this.executor.query(
				`INSERT INTO agent_service_session_access (session_id, user_id, tenant_id) VALUES ($1, $2, $3)`,
				[metadata.id, principal.userId, principal.tenantId],
			);
			return metadata;
		} catch (error) {
			await session.close(BACKGROUND_CONTEXT);
			await this.repo.delete(session.metadata, BACKGROUND_CONTEXT).catch(() => undefined);
			throw error;
		} finally {
			await session.close(BACKGROUND_CONTEXT);
		}
	}

	private async authorizeSession(sessionId: string, principal: Principal): Promise<void> {
		const result = await this.executor.query<SessionAccessRow>(
			"SELECT user_id, tenant_id FROM agent_service_session_access WHERE session_id = $1",
			[sessionId],
		);
		const owner = result.rows[0];
		if (owner === undefined || owner.user_id !== principal.userId || owner.tenant_id !== principal.tenantId) throw new HttpError(404, "Session not found");
	}

	async forkSession(sourceId: string, principal: Principal, options: ForkOptions): Promise<SessionMetadata> {
		await this.ready();
		await this.authorizeSession(sourceId, principal);
		const source = await this.session(sourceId);
		let forked: Awaited<ReturnType<PostgresSessionRepo["fork"]>> | undefined;
		try {
			forked = await this.repo.fork(source, options, BACKGROUND_CONTEXT);
			const metadata = forked.metadata;
			await this.executor.query(
				`INSERT INTO agent_service_session_access (session_id, user_id, tenant_id) VALUES ($1, $2, $3)`,
				[metadata.id, principal.userId, principal.tenantId],
			);
			return metadata;
		} catch (error) {
			if (forked !== undefined) {
				await forked.close(BACKGROUND_CONTEXT);
				await this.repo.delete(forked.metadata, BACKGROUND_CONTEXT).catch(() => undefined);
			}
			throw error;
		} finally {
			if (forked !== undefined) await forked.close(BACKGROUND_CONTEXT);
		}
	}

	private async session(id: string): Promise<SessionMetadata> {
		await this.ready();
		const metadata = (await this.repo.list(undefined, BACKGROUND_CONTEXT)).find((item) => item.id === id);
		if (metadata === undefined) throw new HttpError(404, "Session not found");
		return metadata;
	}

	private model(): { models: Models; model: Model<Api> } {
		return createLocalModel(this.localResponse);
	}

	private async accept(
		sessionMetadata: SessionMetadata,
		prompt: string,
		principal: Principal,
		submission: Submission,
	): Promise<string> {
		const lease = await this.leases.acquire(sessionMetadata.id);
		let session: Awaited<ReturnType<PostgresSessionRepo["openWithLease"]>> | undefined;
		let harness: Awaited<ReturnType<typeof openAgentHarness>>["harness"] | undefined;
		try {
			session = await this.repo.openWithLease(sessionMetadata, lease, BACKGROUND_CONTEXT);
			const model = this.model();
			const opened = await openAgentHarness({
				session,
				models: model.models,
				model: model.model,
				toolContext: {
					principal,
					sessionId: sessionMetadata.id,
					submissionId: submission.id,
					operationId: "admission",
				},
			}, BACKGROUND_CONTEXT);
			harness = opened.harness;
			const lane = await harness.lane("main", BACKGROUND_CONTEXT);
			const result = await lane.accept({ kind: "prompt", prompt }, BACKGROUND_CONTEXT);
			if (!result.ok) throw new HttpError(409, result.error.message);
			return result.value.operationId;
		} finally {
			if (harness !== undefined) await harness.close(BACKGROUND_CONTEXT);
			if (session !== undefined) await session.close(BACKGROUND_CONTEXT);
			await this.leases.release(lease);
		}
	}

	private async startWorkflow(state: WorkflowState, principal: Principal): Promise<void> {
		const current = await this.submissions.get(state.submissionId);
		if (current === undefined || current.status === "completed" || current.status === "failed" || current.status === "cancelled") return;
		if (this.mode === "vercel" && this.workflowStartUrl !== undefined) {
			const response = await fetch(this.workflowStartUrl, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					...(this.workflowToken === undefined ? {} : { authorization: `Bearer ${this.workflowToken}` }),
				},
				body: JSON.stringify(state),
			});
			if (!response.ok) throw new Error(`Workflow start failed: ${response.status}`);
			return;
		}
		if (this.mode === "vercel") throw new Error("WORKFLOW_START_URL is required in vercel mode");
		if (this.activeWorkflows.has(state.submissionId)) return;
		const run = this.runWorkflow(state, principal).finally(() => this.activeWorkflows.delete(state.submissionId));
		this.activeWorkflows.set(state.submissionId, run);
		void run;
	}

	async driveOnce(state: WorkflowState, principal: Principal): Promise<DriveStepResult> {
		const model = this.model();
		const result = await drivePostgresOperation({
			repo: this.repo,
			leases: this.leases,
			session: await this.session(state.sessionId),
			models: model.models,
			model: model.model,
			toolContext: async () => ({ principal, sessionId: state.sessionId, submissionId: state.submissionId, operationId: state.operationId }),
		}, state.operationId, BACKGROUND_CONTEXT);
		if (!result.ok) throw result.error;
		if (result.value.kind === "settled") {
			await this.submissions.transition(state.submissionId, ["accepted", "running", "waiting"], { status: "completed", operationId: state.operationId }).catch(() => undefined);
			return { kind: "completed" };
		}
		if (result.value.reason === "retry") {
			await this.submissions.transition(state.submissionId, ["running", "waiting"], { status: "waiting", operationId: state.operationId }).catch(() => undefined);
			return { kind: "waiting", notBefore: result.value.notBefore };
		}
		await this.submissions.transition(state.submissionId, ["running", "waiting"], { status: "waiting", operationId: state.operationId }).catch(() => undefined);
		return { kind: "waiting" };
	}

	private async runWorkflow(state: WorkflowState, principal: Principal): Promise<void> {
		let lastError: unknown;
		for (let pass = 0; pass < this.maxDrivePasses; pass++) {
			try {
				const outcome = await this.driveOnce(state, principal);
				if (outcome.kind === "completed") return;
				if (outcome.notBefore !== undefined) await wait(Math.max(0, Math.min(30_000, outcome.notBefore - Date.now())));
				else await wait(250);
				await this.submissions.transition(state.submissionId, ["waiting"], { status: "running", operationId: state.operationId }).catch(() => undefined);
			} catch (error) {
				lastError = error;
				await wait(250);
			}
		}
		await this.submissions.transition(state.submissionId, ["accepted", "running", "waiting"], { status: "failed", operationId: state.operationId, errorCode: String(lastError ?? "drive pass limit") }).catch(() => undefined);
	}

	async submit(sessionId: string, prompt: string, principal: Principal, clientRequestId: string): Promise<Submission> {
		await this.ready();
		await this.authorizeSession(sessionId, principal);
		const metadata = await this.session(sessionId);
		const admission = await admitSubmission(
			{ principal, session: metadata, clientRequestId, prompt },
			{ authorize: async (requestPrincipal) => {
				if (requestPrincipal.scopes.length > 0 && !requestPrincipal.scopes.includes("agent:run")) throw new HttpError(403, "Missing agent:run scope");
			} },
			this.submissions,
			(submission, submittedPrompt) => this.accept(metadata, submittedPrompt, principal, submission),
			BACKGROUND_CONTEXT,
			(state) => this.startWorkflow(state, principal),
		);
		return admission.submission;
	}

	async authorizeWorkflow(token: string | undefined): Promise<void> {
		if (this.workflowToken === undefined || token === undefined || token !== this.workflowToken) throw new HttpError(401, "Invalid workflow token");
	}

	async driveInternal(state: WorkflowState): Promise<DriveStepResult> {
		await this.ready();
		const submission = await this.submissions.get(state.submissionId);
		if (submission === undefined || submission.sessionId !== state.sessionId || submission.operationId !== state.operationId) throw new HttpError(404, "Workflow state not found");
		return this.driveOnce(state, { userId: submission.userId, tenantId: submission.tenantId, scopes: ["agent:run"] });
	}

	async getSubmission(id: string, principal: Principal): Promise<Submission> {
		await this.ready();
		const submission = await this.submissions.get(id);
		if (submission === undefined || submission.userId !== principal.userId || submission.tenantId !== principal.tenantId) throw new HttpError(404, "Submission not found");
		return submission;
	}

	async result(id: string, principal: Principal): Promise<{ submission: Submission; entries: unknown[] }> {
		const submission = await this.getSubmission(id, principal);
		if (submission.status !== "completed") throw new HttpError(409, "Submission is not complete");
		const metadata = await this.session(submission.sessionId);
		const session = await this.repo.open(metadata, BACKGROUND_CONTEXT);
		try {
			const model = this.model();
			const opened = await openAgentHarness({ session, models: model.models, model: model.model }, BACKGROUND_CONTEXT);
			try {
				const lane = await opened.harness.lane("main", BACKGROUND_CONTEXT);
				return { submission, entries: await lane.findEntries({ order: "oldestFirst" }, BACKGROUND_CONTEXT) };
			} finally {
				await opened.harness.close(BACKGROUND_CONTEXT);
			}
		} finally {
			await session.close(BACKGROUND_CONTEXT);
		}
	}

	async cancel(id: string, principal: Principal): Promise<Submission> {
		const submission = await this.getSubmission(id, principal);
		if (submission.operationId === null) throw new HttpError(409, "Submission has no operation");
		const metadata = await this.session(submission.sessionId);
		const lease = await this.leases.acquire(metadata.id);
		let session: Awaited<ReturnType<PostgresSessionRepo["openWithLease"]>> | undefined;
		let harness: Awaited<ReturnType<typeof openAgentHarness>>["harness"] | undefined;
		try {
			session = await this.repo.openWithLease(metadata, lease, BACKGROUND_CONTEXT);
			const model = this.model();
			const opened = await openAgentHarness({ session, models: model.models, model: model.model }, BACKGROUND_CONTEXT);
			harness = opened.harness;
			const lane = await harness.lane("main", BACKGROUND_CONTEXT);
			const result = await lane.requestAbort(submission.operationId, BACKGROUND_CONTEXT);
			if (!result.ok) throw new HttpError(409, result.error.message);
		} finally {
			if (harness !== undefined) await harness.close(BACKGROUND_CONTEXT);
			if (session !== undefined) await session.close(BACKGROUND_CONTEXT);
			await this.leases.release(lease);
		}
		return this.submissions.transition(id, ["accepted", "running", "waiting"], { status: "cancelled", operationId: submission.operationId });
	}
}

let defaultService: AgentService | undefined;
export function getDefaultService(): AgentService {
	return defaultService ??= new AgentService();
}

export async function handleRequest(req: VercelRequest, res: ServerResponse, providedService?: AgentService): Promise<void> {
	try {
		const path = requestPath(req);
		if (req.method === "GET" && path === "/api/health") {
			json(res, 200, { ok: true, mode: providedService?.mode ?? (process.env.VERCEL === "1" ? "vercel" : "local") });
			return;
		}
		const service = providedService ?? getDefaultService();
		if (req.method === "POST" && path === "/api/internal/agent-drive") {
			const authorization = asHeader(req.headers.authorization);
			const token = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : asHeader(req.headers["x-workflow-token"]);
			await service.authorizeWorkflow(token);
			const body = await readJson(req);
			const state: WorkflowState = {
				submissionId: stringField(body, "submissionId"),
				sessionId: stringField(body, "sessionId"),
				operationId: stringField(body, "operationId"),
			};
			json(res, 200, await service.driveInternal(state));
			return;
		}
		const principal = principalFromRequest(req, service.mode);
		if (req.method === "POST" && path === "/api/sessions") {
			const body = await readJson(req);
			const id = body.id === undefined ? undefined : stringField(body, "id");
			json(res, 201, { session: await service.createSession(id, principal) });
			return;
		}
		const forkPath = /^\/api\/sessions\/([^/]+)\/fork$/.exec(path);
		if (req.method === "POST" && forkPath !== null) {
			const body = await readJson(req);
			const sourceId = decodeURIComponent(forkPath[1]!);
			json(res, 201, { session: await service.forkSession(sourceId, principal, forkOptions(body)) });
			return;
		}
		const sessionId = sessionIdFromPath(path);
		if (sessionId !== undefined && req.method === "POST" && path.endsWith("/messages")) {
			const body = await readJson(req);
			const prompt = body.content === undefined ? stringField(body, "prompt") : body.content;
			if (typeof prompt !== "string" || prompt.length === 0) throw new HttpError(400, "content must be a non-empty string");
			const clientRequestId = asHeader(req.headers["idempotency-key"]) ?? asHeader(req.headers["x-client-request-id"]);
			if (clientRequestId === undefined || clientRequestId.length === 0) throw new HttpError(400, "Idempotency-Key is required");
			const submission = await service.submit(sessionId, prompt, principal, clientRequestId);
			json(res, 202, { submission });
			return;
		}
		const submissionRoute = submissionPath(path);
		if (submissionRoute === undefined) throw new HttpError(404, "Not found");
		if (req.method === "GET" && submissionRoute.action === undefined) {
			json(res, 200, { submission: await service.getSubmission(submissionRoute.id, principal) });
			return;
		}
		if (req.method === "GET" && submissionRoute.action === "result") {
			json(res, 200, await service.result(submissionRoute.id, principal));
			return;
		}
		if (req.method === "POST" && submissionRoute.action === "cancel") {
			json(res, 200, { submission: await service.cancel(submissionRoute.id, principal) });
			return;
		}
		throw new HttpError(405, "Method not allowed");
	} catch (error) {
		const status = error instanceof HttpError ? error.status : 500;
		json(res, status, { error: error instanceof Error ? error.message : String(error) });
	}
}


