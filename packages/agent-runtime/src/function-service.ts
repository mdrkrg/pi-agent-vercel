import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AgentHarnessTool } from "@earendil-works/pi-agent-core";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core/harness/context";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import { DriveJobRepo, ensurePiPostgresSchema, PgExecutor, PostgresSessionRepo, SessionLeaseManager, SubmissionRepo, type SessionLeaseOptions } from "../../pi-postgres/src/index.ts";
import { PostgresAdmission } from "./admission.ts";
import { PostgresFunctionWorker } from "./function-worker.ts";
import type { Principal } from "./ingress.ts";
import { PostgresSubmissionReader } from "./submission-reader.ts";

export type ServiceToolContext = { readonly principal: Principal; readonly sessionId: string; readonly submissionId: string; readonly operationId: string };
export type FunctionServiceOptions = {
	readonly executor: PgExecutor;
	readonly models: Models;
	readonly model: Model<Api>;
	readonly apiToken: string;
	readonly cronSecret: string;
	readonly principal: Principal;
	readonly tools?: AgentHarnessTool<ServiceToolContext>[];
	readonly lease?: SessionLeaseOptions;
	readonly maxPassMs?: number;
	readonly maxInvocationMs?: number;
};
type Request = IncomingMessage & { readonly body?: unknown };
class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }
function pathId(value: string): string {
	try { return decodeURIComponent(value); } catch { throw new HttpError(400, "Invalid path encoding"); }
}
function authorized(header: string | string[] | undefined, secret: string): boolean {
	if (typeof header !== "string" || secret.length === 0) return false;
	const supplied = Buffer.from(header); const expected = Buffer.from(`Bearer ${secret}`);
	return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
function respond(res: ServerResponse, status: number, value: unknown): void {
	res.statusCode = status; res.setHeader("content-type", "application/json; charset=utf-8"); res.setHeader("cache-control", "no-store"); res.end(JSON.stringify(value));
}
async function body(req: Request): Promise<Record<string, unknown>> {
	let value = req.body;
	if (value === undefined) {
		const chunks: Buffer[] = []; let size = 0;
		for await (const chunk of req) { const part = Buffer.from(chunk); size += part.length; if (size > 1_048_576) throw new HttpError(413, "Request too large"); chunks.push(part); }
		try { value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { throw new HttpError(400, "Invalid JSON body"); }
	}
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "Expected a JSON object");
	return value as Record<string, unknown>;
}

/** A single-principal authenticated PoC shell; each Function owns a fresh composition. */
export class FunctionService {
	readonly repo: PostgresSessionRepo;
	readonly submissions: SubmissionRepo;
	readonly jobs: DriveJobRepo;
	readonly leases: SessionLeaseManager;
	readonly admission: PostgresAdmission<ServiceToolContext>;
	readonly worker: PostgresFunctionWorker<ServiceToolContext>;
	readonly reader: PostgresSubmissionReader;
	private readyPromise: Promise<void> | undefined;
	constructor(private readonly options: FunctionServiceOptions) {
		this.repo = new PostgresSessionRepo(options.executor); this.submissions = new SubmissionRepo(options.executor);
		this.jobs = new DriveJobRepo(options.executor); this.leases = new SessionLeaseManager(options.executor);
		const harnessOptions = async (submission: Awaited<ReturnType<SubmissionRepo["get"]>>) => {
			if (submission === undefined || await this.repo.authorizedMetadata(submission.sessionId, submission.userId, submission.tenantId) === undefined) throw new Error("Submission session authorization unavailable");
			return {
				models: options.models, model: options.model, tools: options.tools ?? [],
				toolContext: { principal: { userId: submission.userId, tenantId: submission.tenantId, scopes: ["agent:run"] }, sessionId: submission.sessionId, submissionId: submission.id, operationId: submission.operationId ?? submission.id },
			};
		};
		const shared = { repo: this.repo, submissions: this.submissions, leases: this.leases, harnessOptions, ...(options.lease === undefined ? {} : { lease: options.lease }) };
		this.admission = new PostgresAdmission(shared);
		this.worker = new PostgresFunctionWorker({ ...shared, jobs: this.jobs, discovery: { models: options.models, model: options.model }, ...(options.maxPassMs === undefined ? {} : { maxPassMs: options.maxPassMs }), ...(options.maxInvocationMs === undefined ? {} : { maxInvocationMs: options.maxInvocationMs }) });
		this.reader = new PostgresSubmissionReader(this.repo, this.submissions);
	}
	ready(): Promise<void> { return this.readyPromise ??= ensurePiPostgresSchema(this.options.executor); }
	async close(): Promise<void> { try { await this.repo.close(BACKGROUND_CONTEXT); } finally { await this.options.executor.close(); } }

	async handle(req: Request, res: ServerResponse): Promise<void> {
		try {
			const pathname = new URL(req.url ?? "/", "http://localhost").pathname.replace(/\/+$/, "");
			if (pathname === "/api/worker" && (req.method === "GET" || req.method === "POST")) {
				if (!authorized(req.headers.authorization, this.options.cronSecret)) throw new HttpError(401, "Unauthorized worker invocation");
				await this.ready(); respond(res, 200, await this.worker.tick(BACKGROUND_CONTEXT)); return;
			}
			if (!authorized(req.headers.authorization, this.options.apiToken)) throw new HttpError(401, "Unauthorized");
			const principal = this.options.principal;
			if (!principal.scopes.includes("agent:run")) throw new HttpError(403, "Missing agent:run scope");
			await this.ready();
			if (req.method === "POST" && pathname === "/api/sessions") {
				const session = await this.repo.createWithOwner(principal, BACKGROUND_CONTEXT);
				const metadata = session.metadata; await session.close(BACKGROUND_CONTEXT); respond(res, 201, { session: metadata }); return;
			}
			const messages = /^\/api\/sessions\/([^/]+)\/messages$/.exec(pathname);
			if (req.method === "POST" && messages !== null) {
				const metadata = await this.repo.authorizedMetadata(pathId(messages[1]!), principal.userId, principal.tenantId);
				if (metadata === undefined) throw new HttpError(404, "Session not found");
				const input = await body(req); const prompt = input.prompt;
				const clientRequestId = req.headers["idempotency-key"];
				if (typeof prompt !== "string" || prompt.length === 0 || prompt.length > 65_536 || typeof clientRequestId !== "string" || clientRequestId.length === 0 || clientRequestId.length > 256) throw new HttpError(400, "Valid prompt and Idempotency-Key are required");
				let accepted;
				try { accepted = await this.admission.submit({ principal, session: metadata, clientRequestId, prompt }, { authorize: async () => undefined }, BACKGROUND_CONTEXT); }
				catch (error) {
					if (error instanceof Error && error.message.startsWith("Submission idempotency key reused")) throw new HttpError(409, error.message);
					throw error;
				}
				respond(res, 202, accepted); return;
			}
			const submission = /^\/api\/submissions\/([^/]+)(\/result)?$/.exec(pathname);
			if (req.method === "GET" && submission !== null) {
				const id = pathId(submission[1]!);
				try { respond(res, 200, submission[2] === undefined ? await this.reader.read(id, principal, BACKGROUND_CONTEXT) : await this.reader.result(id, principal, BACKGROUND_CONTEXT)); }
				catch (error) {
					if (error instanceof Error && error.message === "Submission not found") throw new HttpError(404, error.message);
					if (error instanceof Error && error.message === "Submission result is not complete") throw new HttpError(409, error.message);
					throw error;
				}
				return;
			}
			throw new HttpError(404, "Not found");
		} catch (error) { respond(res, error instanceof HttpError ? error.status : 500, { error: error instanceof HttpError ? error.message : "Internal error" }); }
	}
}
