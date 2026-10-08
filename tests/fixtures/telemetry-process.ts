import { context, propagation, SpanStatusCode } from "@opentelemetry/api";
import { traceFunctionRequest, traceStage } from "../../packages/agent-runtime/src/tracing.ts";

// Separate process: exercise the real SDK without contaminating the test runner's globals.
const reports: unknown[] = [];
const pending: (Promise<unknown> | (() => Promise<unknown>))[] = [];
if (process.argv[2] === "host") {
	Object.defineProperty(globalThis, Symbol.for("@vercel/request-context"), { value: { get: () => ({
		headers: { host: "private-host", "user-agent": "private-user-agent", referer: "https://example.invalid/?token=private-referrer", "x-matched-path": "/private-path" },
		waitUntil: (value: typeof pending[number]) => pending.push(value),
		telemetry: {
			traceDrains: ["memory"],
			rootSpanContext: { traceId: "0123456789abcdef0123456789abcdef", spanId: "0123456789abcdef", traceFlags: 1 },
			reportSpans: (value: unknown) => reports.push(value),
		},
	}) } });
}
const { flushTelemetry } = await import("../../packages/agent-runtime/src/telemetry-bootstrap.ts");
if (process.argv[2] === "host") {
	await traceFunctionRequest({ headers: { baggage: "prompt=private-baggage", authorization: "Bearer private-token" }, url: "/api/worker?token=private-query", method: "POST" } as never, { statusCode: 200 } as never, async () => {
		if (propagation.getBaggage(context.active()) !== undefined) throw new Error("Baggage was accepted");
		await traceStage("function.handle", {}, async (span) => {
			span.setAttribute("unexpected.attribute", "private-attribute");
			span.setStatus({ code: SpanStatusCode.ERROR, message: "private-status" });
			span.addEvent("exception", { "exception.message": "private-exception" });
		});
	});
	await Promise.all(pending.map((value) => typeof value === "function" ? value() : value));
	process.stdout.write(JSON.stringify(reports));
} else {
	await traceStage("worker.tick", {}, async () => undefined);
	await flushTelemetry();
}
