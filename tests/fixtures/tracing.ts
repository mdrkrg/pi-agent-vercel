import { context, propagation, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor, type SpanProcessor } from "@opentelemetry/sdk-trace-base";

/** In-memory only: tests must never export to an inherited cloud collector. */
export function captureTracing(processors: SpanProcessor[] = []) {
	const exporter = new InMemorySpanExporter();
	const provider = new BasicTracerProvider({ spanProcessors: [...processors, new SimpleSpanProcessor(exporter)] });
	const manager = new AsyncLocalStorageContextManager().enable();
	trace.setGlobalTracerProvider(provider);
	context.setGlobalContextManager(manager);
	propagation.setGlobalPropagator(new W3CTraceContextPropagator());
	return {
		exporter,
		async close() {
			await provider.shutdown();
			manager.disable();
			trace.disable(); context.disable(); propagation.disable();
		},
	};
}
