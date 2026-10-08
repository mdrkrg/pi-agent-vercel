import { registerOTel } from "@vercel/otel";
import { trace, type TracerProvider } from "@opentelemetry/api";
import { contentFreeSpanProcessor } from "./telemetry-policy.ts";

type FlushableProvider = TracerProvider & { forceFlush?: () => Promise<void>; getDelegate?: () => FlushableProvider };
let provider: FlushableProvider | undefined;

// Explicit entry bootstrap: this is a plain Node Function, not a Next.js hook.
// Local development stays exporter-free unless a collector endpoint is configured.
if (process.env.OTEL_SDK_DISABLED !== "true" && (process.env.VERCEL === "1"
	|| process.env.OTEL_EXPORTER_OTLP_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT)) {
	try {
		registerOTel({
			serviceName: "pi-agent-vercel",
			instrumentations: [],
			propagators: ["tracecontext"],
			// Sanitize after SDK header enrichment and before either automatic exporter.
			spanProcessors: [contentFreeSpanProcessor, "auto"],
		});
		const registered = trace.getTracerProvider() as FlushableProvider;
		provider = registered.getDelegate?.() ?? registered;
	} catch { /* SDK configuration/delivery is never execution authority. */ }
}

/** One-shot CLI processes have no Vercel waitUntil hook to flush the batch. */
export async function flushTelemetry(timeoutMs = 1_000): Promise<void> {
	if (provider?.forceFlush === undefined) return;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			provider.forceFlush(),
			new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
		]);
	} catch { /* Export failure must not replace the CLI result or cleanup error. */ }
	finally { if (timer !== undefined) clearTimeout(timer); }
}
