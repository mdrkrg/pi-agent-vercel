import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core/harness/context";
import { MemorySessionRepo } from "@earendil-works/pi-agent-core/harness/session";
import type { AgentHarnessTool } from "@earendil-works/pi-agent-core";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { acceptPrompt, driveOperation, openAgentHarness, requestOperationAbort } from "../packages/agent-runtime/src/index.ts";

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

	it("passes reconstructed tool context and a stable invocation identity", async () => {
		const models = createModels();
		const faux = fauxProvider();
		models.setProvider(faux.provider);
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("whoami", { value: "request" }, { id: "provider-call-1" })),
			fauxAssistantMessage("tool complete"),
		]);
		const calls: Array<{ toolCallId: string; invocationId: string; operationId: string; userId: string }> = [];
		type ToolContext = { principal: { userId: string }; operationId: string };
		let contextResolutions = 0;
		const tool: AgentHarnessTool<ToolContext> = {
			name: "whoami",
			label: "Who am I",
			description: "Return the current principal.",
			parameters: {
				type: "object",
				properties: { value: { type: "string" } },
				required: ["value"],
			},
			replay: "never",
			execute: async (toolCallId, _params, _onUpdate, toolContext, invocation) => {
				calls.push({
					toolCallId,
					invocationId: invocation.invocationId,
					operationId: invocation.operationId,
					userId: toolContext.principal.userId,
				});
				return { content: [{ type: "text", text: toolContext.principal.userId }], details: { userId: toolContext.principal.userId } };
			},
		};
		const repo = new MemorySessionRepo();
		const session = await repo.create({ id: "memory-tool-session" }, BACKGROUND_CONTEXT);
		let operationId = "pending";
		const opened = await openAgentHarness(
			{
				session,
				models,
				model: faux.getModel(),
				tools: [tool],
				toolContext: () => {
					contextResolutions++;
					return { principal: { userId: "user-1" }, operationId };
				},
			},
			BACKGROUND_CONTEXT,
		);
		const lane = await opened.harness.lane("main", BACKGROUND_CONTEXT);
		const admission = await acceptPrompt(lane, "call the tool", BACKGROUND_CONTEXT);
		if (!admission.ok) throw admission.error;
		operationId = admission.value.operationId;
		const driven = await driveOperation(lane, admission.value.operationId, BACKGROUND_CONTEXT);
		if (!driven.ok) throw driven.error;
		expect(driven.value.kind).toBe("settled");
		expect(calls).toHaveLength(1);
		expect(contextResolutions).toBeGreaterThan(0);
		expect(calls[0]).toMatchObject({
			toolCallId: "provider-call-1",
			operationId: admission.value.operationId,
			userId: "user-1",
		});
		expect(calls[0]?.invocationId).toBeTruthy();
		await opened.harness.close(BACKGROUND_CONTEXT);
		await session.close(BACKGROUND_CONTEXT);
		await repo.close(BACKGROUND_CONTEXT);
	});

	it("records a durable abort request before a drive pass starts", async () => {
		const models = createModels();
		const faux = fauxProvider();
		models.setProvider(faux.provider);
		faux.setResponses([fauxAssistantMessage("will not run")]);
		const repo = new MemorySessionRepo();
		const session = await repo.create({ id: "memory-abort-session" }, BACKGROUND_CONTEXT);
		const opened = await openAgentHarness({ session, models, model: faux.getModel() }, BACKGROUND_CONTEXT);
		const lane = await opened.harness.lane("main", BACKGROUND_CONTEXT);
		const admission = await acceptPrompt(lane, "abort me", BACKGROUND_CONTEXT);
		if (!admission.ok) throw admission.error;
		const aborted = await requestOperationAbort(lane, admission.value.operationId, BACKGROUND_CONTEXT);
		expect(aborted.ok).toBe(true);
		if (aborted.ok) expect(aborted.value.newlyRequested).toBe(true);
		await opened.harness.close(BACKGROUND_CONTEXT);
		await session.close(BACKGROUND_CONTEXT);
		await repo.close(BACKGROUND_CONTEXT);
	});
});
