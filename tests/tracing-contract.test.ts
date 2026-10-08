import type { IncomingMessage, ServerResponse } from "node:http";
import { trace, SpanKind, SpanStatusCode, type Span } from "@opentelemetry/api";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { annotateSpan, traceFunctionRequest, traceStage } from "../packages/agent-runtime/src/tracing.ts";
import { captureTracing } from "./fixtures/tracing.ts";

const capture = captureTracing();
afterEach(() => capture.exporter.reset());
afterAll(() => capture.close());

function request(url = "/api/worker", headers: IncomingMessage["headers"] = {}, method = "POST") {
	return { url, headers, method } as IncomingMessage;
}
function response(statusCode = 200) { return { statusCode } as ServerResponse; }

describe("content-free Function tracing", () => {
	it("keeps nested phases active across awaits and returns the original value", async () => {
		const value = { result: "not exported" };
		expect(await traceStage("worker.tick", {}, async () => {
			await Promise.resolve();
			return traceStage("worker.discover", {}, async () => value);
		})).toBe(value);
		const spans = capture.exporter.getFinishedSpans();
		const parent = spans.find((span) => span.name === "worker.tick")!;
		const child = spans.find((span) => span.name === "worker.discover")!;
		expect(child.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
		expect(child.spanContext().traceId).toBe(parent.spanContext().traceId);
		expect(parent.duration[0] * 1e9 + parent.duration[1]).toBeGreaterThan(0);
		expect(parent.endTime).toBeDefined();
	});

	it("preserves thrown identity, marks an error, ends spans, and does not export exceptions", async () => {
		const error = new Error("sensitive prompt / provider credential");
		await expect(traceStage("job.drive", {}, async () => { throw error; })).rejects.toBe(error);
		const [span] = capture.exporter.getFinishedSpans();
		expect(span!.status).toEqual({ code: SpanStatusCode.ERROR });
		expect(span!.events).toEqual([]);
		expect(JSON.stringify(span!.attributes)).not.toContain(error.message);
	});

	it("extracts W3C parent context without baggage and exports only a route template", async () => {
		const traceId = "0123456789abcdef0123456789abcdef";
		const parentId = "0123456789abcdef";
		await traceFunctionRequest(request("/api/submissions/private-prompt/result?token=credential", {
			traceparent: `00-${traceId}-${parentId}-01`,
			baggage: "prompt=private-prompt", authorization: "Bearer credential", "x-user-id": "attacker",
		}), response(), () => traceStage("function.handle", {}, async () => undefined));
		const spans = capture.exporter.getFinishedSpans();
		const root = spans.find((span) => span.name === "function.request")!;
		expect(root.kind).toBe(SpanKind.SERVER);
		expect(root.spanContext().traceId).toBe(traceId);
		expect(root.parentSpanContext?.spanId).toBe(parentId);
		expect(root.attributes).toEqual({ "http.request.method": "POST", "http.route": "/api/submissions/:id/result", "http.response.status_code": 200 });
		expect(spans.find((span) => span.name === "function.handle")!.parentSpanContext?.spanId).toBe(root.spanContext().spanId);
		expect(JSON.stringify(spans.map((span) => ({ attributes: span.attributes, events: span.events })))).not.toMatch(/private-prompt|credential|attacker|baggage/);
	});

	it("isolates concurrent invocations and inherits the active host span without trace headers", async () => {
		await Promise.all([1, 2].map((id) => traceStage("worker.tick", { "test.id": id }, async () => {
			await new Promise((resolve) => setTimeout(resolve, id));
			await traceFunctionRequest(request(), response(), async () => { await Promise.resolve(); });
		})));
		const spans = capture.exporter.getFinishedSpans();
		const parents = spans.filter((span) => span.name === "worker.tick");
		expect(new Set(parents.map((span) => span.spanContext().traceId)).size).toBe(2);
		for (const parent of parents) {
			expect(spans.filter((span) => span.parentSpanContext?.spanId === parent.spanContext().spanId)).toHaveLength(1);
		}
		expect(trace.getActiveSpan()).toBeUndefined();
	});

	it.each([401, 404, 500])("records handled HTTP %s without exception contents", async (status) => {
		await traceFunctionRequest(request("/unknown/secret", {}, "secret"), response(status), async () => undefined);
		const [span] = capture.exporter.getFinishedSpans();
		expect(span!.attributes).toMatchObject({ "http.request.method": "OTHER", "http.route": "unmatched", "http.response.status_code": status });
		expect(span!.status.code).toBe(status >= 500 ? SpanStatusCode.ERROR : SpanStatusCode.UNSET);
	});

	it("does not let failed annotations change execution authority", () => {
		const span = { setAttributes() { throw new Error("broken processor"); } } as unknown as Span;
		expect(() => annotateSpan(span, { "agent.driven.count": 1 })).not.toThrow();
	});
});
