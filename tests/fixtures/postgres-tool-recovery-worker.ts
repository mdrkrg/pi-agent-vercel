import { appendFileSync } from "node:fs";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core/harness/context";
import type { AgentHarnessTool } from "@earendil-works/pi-agent-core";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { PgExecutor, PostgresSessionRepo, SessionLeaseManager } from "../../packages/pi-postgres/src/index.ts";
import { acceptPrompt, driveOperation, drivePostgresOperation, openAgentHarness } from "../../packages/agent-runtime/src/index.ts";

const mode = process.argv[2] as "start" | "resume" | undefined;
const sessionId = process.env.POC_SESSION_ID;
const databaseUrl = process.env.DATABASE_URL;
const effectFile = process.env.POC_EFFECT_FILE;
const replay = process.env.POC_REPLAY === "safe" ? "safe" : "never";
if (mode === undefined || sessionId === undefined || databaseUrl === undefined || effectFile === undefined) throw new Error("worker configuration is incomplete");

const executor = new PgExecutor({ connectionString: databaseUrl });
const models = createModels();
const faux = fauxProvider();
models.setProvider(faux.provider);
if (mode === "start") faux.setResponses([fauxAssistantMessage(fauxToolCall("effect", { value: "start" }, { id: "effect-call" }))]);
else faux.setResponses([fauxAssistantMessage("recovered final")]);
const model = faux.getModel();
const tool: AgentHarnessTool<{ phase: "start" | "resume" }> = {
	name: "effect",
	label: "External effect",
	description: "Test effect boundary",
	parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
	replay,
	execute: async () => {
		appendFileSync(effectFile, `${mode}\n`);
		if (mode === "start") await new Promise<void>(() => undefined);
		return { content: [{ type: "text", text: "effect settled" }], details: undefined };
	},
};

try {
	if (mode === "start") {
		const repo = new PostgresSessionRepo(executor);
		const leases = new SessionLeaseManager(executor);
		const lease = await leases.acquire(sessionId, { holderId: "tool-start", ttlMs: 1_000 });
		const session = await repo.createWithLease({ id: sessionId }, lease, BACKGROUND_CONTEXT);
		const opened = await openAgentHarness({ session, models, model, tools: [tool], toolContext: { phase: "start" } }, BACKGROUND_CONTEXT);
		const lane = await opened.harness.lane("main", BACKGROUND_CONTEXT);
		const admission = await acceptPrompt(lane, "run effect", BACKGROUND_CONTEXT);
		if (!admission.ok) throw admission.error;
		appendFileSync(`${effectFile}.operation`, `${admission.value.operationId}\n`);
		await driveOperation(lane, admission.value.operationId, BACKGROUND_CONTEXT);
	} else {
		const repo = new PostgresSessionRepo(executor);
		const operationId = process.env.POC_OPERATION_ID;
		if (operationId === undefined) throw new Error("POC_OPERATION_ID is required");
		const leases = new SessionLeaseManager(executor);
		const driven = await drivePostgresOperation({ repo, leases, session: { id: sessionId, createdAt: 0, storageVersion: 1 }, models, model, tools: [tool], toolContext: { phase: "resume" } }, operationId, BACKGROUND_CONTEXT);
		if (!driven.ok || driven.value.kind !== "settled") throw new Error(`recovery did not settle: ${JSON.stringify(driven)}`);
		process.stdout.write(`${JSON.stringify({ status: driven.value.outcome.status })}\n`);
	}
	await executor.close();
} catch (error) {
	await executor.close().catch(() => undefined);
	process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
	process.exitCode = 1;
}
