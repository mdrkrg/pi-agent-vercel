import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core/harness/context";
import { MemorySessionRepo } from "@earendil-works/pi-agent-core/harness/session";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { acceptPrompt, driveOperation, openAgentHarness } from "../packages/agent-runtime/src/index.ts";

describe("AgentHarness runtime contract", () => {
	it("accepts, drives, closes, and reopens a text operation", async () => {
		const models = createModels();
		const faux = fauxProvider();
		models.setProvider(faux.provider);
		faux.setResponses([fauxAssistantMessage("durable hello")]);
		const model = faux.getModel();
		const repo = new MemorySessionRepo();
		const session = await repo.create({ id: "memory-session" }, BACKGROUND_CONTEXT);
		const first = await openAgentHarness({ session, models, model }, BACKGROUND_CONTEXT);
		const firstLane = await first.harness.lane("main", BACKGROUND_CONTEXT);
		const admission = await acceptPrompt(firstLane, "hello", BACKGROUND_CONTEXT);
		expect(admission.ok).toBe(true);
		if (!admission.ok) return;
		const driven = await driveOperation(firstLane, admission.value.operationId, BACKGROUND_CONTEXT);
		expect(driven.ok).toBe(true);
		if (!driven.ok) return;
		expect(driven.value.kind).toBe("settled");
		if (driven.value.kind !== "settled") return;
		expect(driven.value.outcome.status).toBe("completed");
		await first.harness.close(BACKGROUND_CONTEXT);
		await session.close(BACKGROUND_CONTEXT);

		const reopened = await repo.open(session.metadata, BACKGROUND_CONTEXT);
		const second = await openAgentHarness({ session: reopened, models, model }, BACKGROUND_CONTEXT);
		const secondLane = await second.harness.lane("main", BACKGROUND_CONTEXT);
		expect(await secondLane.getResult(admission.value.operationId, BACKGROUND_CONTEXT)).toMatchObject({
			operationId: admission.value.operationId,
			status: "completed",
		});
		expect((await secondLane.findEntries({ order: "oldestFirst" }, BACKGROUND_CONTEXT)).map((entry) => entry.type)).toEqual([
			"message",
			"message",
		]);
		await second.harness.close(BACKGROUND_CONTEXT);
		await reopened.close(BACKGROUND_CONTEXT);
		await repo.close(BACKGROUND_CONTEXT);
	});
});
