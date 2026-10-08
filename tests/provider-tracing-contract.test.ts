import { SpanStatusCode, trace, type Tracer } from "@opentelemetry/api";
import { createAssistantMessageEventStream, createModels, fauxAssistantMessage, fauxProvider, type AssistantMessageEvent, type Models, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { tracedModels } from "../packages/agent-runtime/src/provider-tracing.ts";
import { traceStage } from "../packages/agent-runtime/src/tracing.ts";
import { contentFreeSpanProcessor } from "../packages/agent-runtime/src/telemetry-policy.ts";
import { captureTracing } from "./fixtures/tracing.ts";

const capture = captureTracing([contentFreeSpanProcessor]);
afterEach(() => { capture.exporter.reset(); vi.restoreAllMocks(); });
afterAll(() => capture.close());
const model = fauxProvider().getModel();
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function fixture() {
	const stream = createAssistantMessageEventStream();
	const result = fauxAssistantMessage("private-answer");
	const dispatch = vi.fn((_model: unknown, _context: unknown, _options?: SimpleStreamOptions) => stream);
	const models = { streamSimple: dispatch, stream: dispatch, streamDeferred: dispatch } as unknown as Models;
	return { stream, result, dispatch, models: tracedModels(models) };
}
const exported = () => JSON.stringify(capture.exporter.getFinishedSpans().map((span) => ({ name: span.name, attributes: span.attributes, events: span.events, status: span.status })));

describe("provider stream timing", () => {
	it("observes first emission and completion without waiting for a slow durable consumer", async () => {
		const { stream, result, dispatch, models } = fixture();
		const push = stream.push;
		const callback = vi.fn();
		const controller = new AbortController();
		await traceStage("job.drive", {}, async () => {
			expect(models.streamSimple(model, { messages: [] }, { signal: controller.signal, apiKey: "private-key", onResponse: callback })).toBe(stream);
			const options = dispatch.mock.calls[0]![2]!;
			expect(options.signal).toBe(controller.signal); expect(options.apiKey).toBe("private-key");
			const response = { status: 200, headers: { authorization: "private-header" } };
			await options.onResponse!(response, model);
			expect(callback).toHaveBeenCalledWith(response, model);
			const events: AssistantMessageEvent[] = [
				{ type: "start", partial: result },
				{ type: "thinking_delta", contentIndex: 0, delta: "private-thinking", partial: result },
				{ type: "text_delta", contentIndex: 0, delta: "", partial: result },
				{ type: "text_delta", contentIndex: 0, delta: "private-answer", partial: result },
				{ type: "done", reason: "stop", message: result },
			];
			for (const event of events) stream.push(event);
			stream.end(result);
			await tick();
			const provider = capture.exporter.getFinishedSpans().find((span) => span.name === "provider.request")!;
			expect(provider.attributes).toMatchObject({ "agent.provider.request.kind": "stream", "agent.provider.outcome": "stop", "agent.provider.cancel_requested": false });
			for (const name of ["first_content_ms", "first_text_ms", "response_headers_ms", "total_ms"]) expect(provider.attributes[`agent.provider.${name}`]).toBeGreaterThanOrEqual(0);
			expect(provider.attributes["agent.provider.first_text_ms"]).toBeGreaterThanOrEqual(provider.attributes["agent.provider.first_content_ms"] as number);
			const received = [];
			for await (const event of stream) received.push(event);
			expect(received).toHaveLength(events.length); received.forEach((event, index) => expect(event).toBe(events[index]));
			expect(await stream.result()).toBe(result);
		});
		expect(dispatch).toHaveBeenCalledOnce(); expect(stream.push).toBe(push);
		const spans = capture.exporter.getFinishedSpans();
		expect(spans.find((span) => span.name === "provider.request")!.parentSpanContext?.spanId).toBe(spans.find((span) => span.name === "job.drive")!.spanContext().spanId);
		expect(exported()).not.toContain("private-");
	});

	it("ends tracing at cancellation without aborting or settling the original stream", async () => {
		const { stream, result, models } = fixture(); const push = stream.push;
		const controller = new AbortController();
		models.streamSimple(model, { messages: [] }, { signal: controller.signal });
		controller.abort(new Error("private-ownership-loss"));
		await tick();
		const span = capture.exporter.getFinishedSpans().find((span) => span.name === "provider.request")!;
		expect(span.attributes).toMatchObject({ "agent.provider.outcome": "interrupted", "agent.provider.cancel_requested": true });
		expect(span.status.code).toBe(SpanStatusCode.ERROR);
		expect(stream.push).toBe(push);
		stream.push({ type: "done", reason: "stop", message: result }); stream.end(result);
		expect(await stream.result()).toBe(result); await tick();
		expect(capture.exporter.getFinishedSpans()).toHaveLength(1);
		expect(exported()).not.toContain("private-");
	});

	it("preserves synchronous dispatch errors", async () => {
		const failure = new Error("private-auth-failure");
		const dispatch = vi.fn(() => { throw failure; });
		const models = tracedModels({ streamSimple: dispatch } as unknown as Models);
		expect(() => models.streamSimple(model, { messages: [] })).toThrow(failure);
		await tick(); expect(dispatch).toHaveBeenCalledOnce();
		expect(capture.exporter.getFinishedSpans()[0]!.status.code).toBe(SpanStatusCode.ERROR);
		expect(exported()).not.toContain("private-");
	});

	it.each(["complete", "completeSimple", "fetchDeferred"] as const)("returns a rejected Promise for %s when dispatch throws", async (method) => {
		const { models, dispatch } = fixture();
		const failure = new Error("private-dispatch-failure");
		dispatch.mockImplementationOnce(() => { throw failure; });
		const handle = { id: "private-handle", api: model.api, provider: model.provider, modelId: model.id };
		const pending = method === "fetchDeferred" ? models.fetchDeferred(model, handle) : models[method](model, { messages: [] });
		expect(pending).toBeInstanceOf(Promise);
		await expect(pending).rejects.toBe(failure);
		await tick(); expect(dispatch).toHaveBeenCalledOnce();
		expect(exported()).not.toContain("private-");
	});

	it("keeps provider error events and result identities without exporting their messages", async () => {
		const { stream, models } = fixture();
		models.streamSimple(model, { messages: [] });
		const result = fauxAssistantMessage("private-partial", { stopReason: "error", errorMessage: "private-provider-error" });
		const event: AssistantMessageEvent = { type: "error", reason: "error", error: result };
		stream.push(event); stream.end(result);
		expect(await stream.result()).toBe(result); await tick();
		expect(capture.exporter.getFinishedSpans()[0]!.attributes["agent.provider.outcome"]).toBe("error");
		expect(exported()).not.toContain("private-");
	});

	it("supports deferred polling and result-only consumers", async () => {
		const { stream, result, dispatch, models } = fixture();
		const handle = { id: "private-handle", api: model.api, provider: model.provider, modelId: model.id };
		const pending = models.fetchDeferred(model, handle);
		stream.push({ type: "done", reason: "stop", message: result }); stream.end(result);
		expect(await pending).toBe(result); await tick();
		expect(dispatch.mock.calls[0]![1]).toBe(handle);
		expect(capture.exporter.getFinishedSpans()[0]!.attributes["agent.provider.request.kind"]).toBe("deferred");
		expect(exported()).not.toContain("private-");
	});

	it("falls back to the original stream if telemetry setup fails", async () => {
		vi.spyOn(trace, "getTracer").mockReturnValue({ startSpan() { throw new Error("private-processor-error"); } } as unknown as Tracer);
		const { stream, result, models, dispatch } = fixture();
		expect(models.streamSimple(model, { messages: [] })).toBe(stream);
		stream.push({ type: "done", reason: "stop", message: result }); stream.end(result);
		expect(await stream.result()).toBe(result); await tick();
		expect(dispatch).toHaveBeenCalledOnce();
	});

	it("handles an already aborted signal without settling the provider stream", async () => {
		const { stream, result, models, dispatch } = fixture();
		const controller = new AbortController(); controller.abort("private-abort-reason");
		expect(models.streamSimple(model, { messages: [] }, { signal: controller.signal })).toBe(stream);
		await tick(); expect(dispatch).toHaveBeenCalledOnce();
		expect(capture.exporter.getFinishedSpans()[0]!.attributes["agent.provider.outcome"]).toBe("interrupted");
		stream.end(result); expect(await stream.result()).toBe(result);
		expect(exported()).not.toContain("private-");
	});

	it("supports frozen prefilled streams without inventing a first-token duration", async () => {
		const { stream, result, models } = fixture();
		stream.push({ type: "done", reason: "stop", message: result }); stream.end(result);
		Object.freeze(stream);
		expect(models.stream(model, { messages: [] })).toBe(stream);
		expect(await stream.result()).toBe(result); await tick();
		const attributes = capture.exporter.getFinishedSpans()[0]!.attributes;
		expect(attributes["agent.provider.outcome"]).toBe("stop");
		expect(attributes).not.toHaveProperty("agent.provider.first_content_ms");
	});

	it("delegates real catalog/auth methods with their original receiver", async () => {
		const original = createModels(); const faux = fauxProvider(); original.setProvider(faux.provider);
		faux.setResponses([fauxAssistantMessage("private-real-faux-answer")]);
		const models = tracedModels(original);
		expect(models.getModel(faux.provider.id, faux.getModel().id)).toEqual(faux.getModel());
		expect((await models.completeSimple(faux.getModel(), { messages: [] })).content).toEqual([{ type: "text", text: "private-real-faux-answer" }]);
		await tick(); expect(capture.exporter.getFinishedSpans().filter((span) => span.name === "provider.request")).toHaveLength(1);
		expect(exported()).not.toContain("private-");
	});
});
