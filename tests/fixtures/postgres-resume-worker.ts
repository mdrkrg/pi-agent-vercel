import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core/harness/context";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { PgExecutor, PostgresSessionRepo } from "../../packages/pi-postgres/src/index.ts";
import { acceptPrompt, driveOperation, openAgentHarness } from "../../packages/agent-runtime/src/index.ts";

const mode = process.argv[2];
const sessionId = process.env.POC_SESSION_ID;
const databaseUrl = process.env.DATABASE_URL;

if (sessionId === undefined || databaseUrl === undefined) {
	throw new Error("POC_SESSION_ID and DATABASE_URL are required");
}

const executor = new PgExecutor({ connectionString: databaseUrl });
const models = createModels();
const faux = fauxProvider();
models.setProvider(faux.provider);
faux.setResponses([fauxAssistantMessage("fresh process response")]);
const model = faux.getModel();

try {
	if (mode === "start") {
		const repo = new PostgresSessionRepo(executor);
		const session = await repo.create({ id: sessionId }, BACKGROUND_CONTEXT);
		const opened = await openAgentHarness({ session, models, model }, BACKGROUND_CONTEXT);
		const lane = await opened.harness.lane("main", BACKGROUND_CONTEXT);
		const admission = await acceptPrompt(lane, "resume me", BACKGROUND_CONTEXT);
		if (!admission.ok) throw new Error(`accept failed: ${admission.error.message}`);
		await opened.harness.close(BACKGROUND_CONTEXT);
		await session.close(BACKGROUND_CONTEXT);
		process.stdout.write(
			`${JSON.stringify({ operationId: admission.value.operationId, sessionId, createdAt: session.metadata.createdAt })}\n`,
			() => process.exit(0),
		);
	} else if (mode === "resume") {
		const repo = new PostgresSessionRepo(executor);
		const session = await repo.open(
			{ id: sessionId, createdAt: 0, storageVersion: 1 },
			BACKGROUND_CONTEXT,
		);
		const operationId = process.env.POC_OPERATION_ID;
		if (operationId === undefined) throw new Error("POC_OPERATION_ID is required");
		const opened = await openAgentHarness({ session, models, model }, BACKGROUND_CONTEXT);
		const lane = await opened.harness.lane("main", BACKGROUND_CONTEXT);
		const driven = await driveOperation(lane, operationId, BACKGROUND_CONTEXT);
		if (!driven.ok || driven.value.kind !== "settled") throw new Error(`drive did not settle: ${JSON.stringify(driven)}`);
		const result = await lane.getResult(operationId, BACKGROUND_CONTEXT);
		const entries = await lane.findEntries({ order: "oldestFirst" }, BACKGROUND_CONTEXT);
		await opened.harness.close(BACKGROUND_CONTEXT);
		await session.close(BACKGROUND_CONTEXT);
		await repo.close(BACKGROUND_CONTEXT);
		process.stdout.write(
			`${JSON.stringify({ status: result?.status, entries: entries.map((entry) => entry.type) })}\n`,
			() => process.exit(0),
		);
	} else {
		throw new Error(`Unknown worker mode: ${String(mode)}`);
	}
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`, () => process.exit(1));
}
