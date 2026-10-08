import { registerOTel } from "@vercel/otel";

// Explicit entry bootstrap: this is a plain Node Function, not a Next.js hook.
// Local development stays exporter-free unless a collector endpoint is configured.
if (process.env.OTEL_SDK_DISABLED !== "true" && (process.env.VERCEL === "1"
	|| process.env.OTEL_EXPORTER_OTLP_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT)) {
	registerOTel({
		serviceName: "pi-agent-vercel",
		// Default fetch instrumentation exports raw URLs/errors. Keep application
		// telemetry content-free; provider timing is included in job.drive instead.
		instrumentations: [],
		propagators: ["tracecontext"],
	});
}
