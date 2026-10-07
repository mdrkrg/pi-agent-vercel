import { appendFileSync } from "node:fs";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core/harness/context";
import type { AgentHarnessTool } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { FunctionService, type ServiceToolContext } from "../../packages/agent-runtime/src/index.ts";
import { PgExecutor } from "../../packages/pi-postgres/src/index.ts";

const mode = process.argv[2]; const phase = process.env.TEST_CRASH_PHASE;
const databaseUrl = process.env.DATABASE_URL; const effectFile = process.env.TEST_EFFECT_FILE;
if (databaseUrl === undefined || effectFile === undefined) throw new Error("Crash worker configuration missing");
async function crashPoint(): Promise<never> {
	await new Promise<void>((resolve, reject) => process.send!({ ready: true }, (error) => error == null ? resolve() : reject(error)));
	return new Promise<never>(() => undefined);
}
const models = createModels(); const faux = fauxProvider();
const model = faux.getModel(); const handle = { provider: model.provider, modelId: model.id, api: model.api, id: "durable-provider-handle", pollAfterMs: 500 };
models.setProvider(phase === "deferred" ? { ...faux.provider, fetchDeferred: (requestModel, persistedHandle) => {
	appendFileSync(`${effectFile}.deferred`, `${JSON.stringify({ mode, id: persistedHandle.id })}\n`);
	const stream = createAssistantMessageEventStream();
	const reason = mode === "start" ? "deferred" : "stop";
	const message = { ...fauxAssistantMessage(mode === "start" ? "" : "deferred answer", { stopReason: reason, ...(mode === "start" ? { deferred: persistedHandle } : {}) }), api: requestModel.api, provider: requestModel.provider, model: requestModel.id };
	queueMicrotask(() => { stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason, message }); stream.end(message); });
	return stream;
} } : faux.provider);
faux.setResponses([async () => {
	appendFileSync(`${effectFile}.provider`, `${mode}\n`);
	if (mode === "start" && phase === "provider") return crashPoint();
	if (mode === "start" && phase === "deferred") return fauxAssistantMessage("", { stopReason: "deferred", deferred: handle });
	return mode === "start" && phase === "tool" ? fauxAssistantMessage(fauxToolCall("effect", {}, { id: "call" })) : fauxAssistantMessage("recovered answer");
}, fauxAssistantMessage("recovered answer")]);
const tool: AgentHarnessTool<ServiceToolContext> = {
	name: "effect", label: "Effect", description: "Record a crash boundary", parameters: { type: "object", properties: {} },
	replay: process.env.TEST_REPLAY === "safe" ? "safe" : "never",
	execute: async (_id, _args, _update, context, invocation) => {
		appendFileSync(effectFile, `${JSON.stringify({ mode, invocationId: invocation.invocationId, principal: context.principal, operationId: context.operationId, sessionId: context.sessionId })}\n`);
		if (mode === "start") return crashPoint();
		return { content: [{ type: "text", text: "effect recovered" }], details: undefined };
	},
};
const service = new FunctionService({ executor: new PgExecutor({ connectionString: databaseUrl }), models, model: faux.getModel(), tools: [tool], apiToken: "test-api", cronSecret: "test-cron", principal: { userId: "crash-user", tenantId: "crash-tenant", scopes: ["agent:run"] }, lease: { ttlMs: 600 }, maxPassMs: 30_000, maxInvocationMs: 35_000 });
try {
	await service.ready();
	if (mode === "start") {
		const sessionId = process.env.TEST_SESSION_ID;
		if (sessionId === undefined) throw new Error("Start requires a session");
		if (phase === "before-accept") {
			const create = service.submissions.create.bind(service.submissions);
			service.submissions.create = async (input) => { await create(input); return crashPoint(); };
		} else if (phase === "after-accept" || phase === "after-publish") {
			const attach = service.submissions.attachOperationAndEnqueue.bind(service.submissions);
			service.submissions.attachOperationAndEnqueue = async (...args) => {
				if (phase === "after-accept") return crashPoint();
				await attach(...args); return crashPoint();
			};
		} else if (phase === "after-terminal") {
			const complete = service.jobs.complete.bind(service.jobs);
			service.jobs.complete = async (...args) => { await complete(...args); return crashPoint(); };
		} else if (phase === "deferred") {
			const reschedule = service.jobs.reschedule.bind(service.jobs);
			service.jobs.reschedule = async (...args) => { await reschedule(...args); return crashPoint(); };
		}
		const metadata = await service.repo.authorizedMetadata(sessionId, "crash-user", "crash-tenant");
		if (metadata === undefined) throw new Error("Session unavailable");
		await service.admission.submit({ principal: { userId: "crash-user", tenantId: "crash-tenant", scopes: ["agent:run"] }, session: metadata, clientRequestId: "request", prompt: "recover without client retry" }, { authorize: async () => undefined }, BACKGROUND_CONTEXT);
	}
	await service.worker.tick(BACKGROUND_CONTEXT);
	process.stdout.write("worker completed\n");
} finally { await service.close(); }
