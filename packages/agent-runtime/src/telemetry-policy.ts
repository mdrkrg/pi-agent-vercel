import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";

const attributes = new Set([
	"http.request.method", "http.route", "http.response.status_code",
	"agent.submission.id", "agent.submission.created", "agent.operation.id",
	"agent.job.id", "agent.job.attempt", "agent.job.status", "agent.job.eligible_delay_ms", "agent.job.age_ms",
	"agent.invocation.budget_ms", "agent.pass.budget_ms", "agent.invocation.exhausted",
	"agent.worker.phase", "agent.worker.deadline_phase", "agent.drive.outcome",
	"agent.admission.processed.count", "agent.admission.error.count", "agent.discovered.count", "agent.driven.count",
	"agent.reconcile.processed.count", "agent.reconcile.error.count", "agent.discovery.session.count", "agent.discovery.open.count",
]);

/** Runs before SDK exporters: the Vercel processor adds raw request headers even without fetch instrumentation. */
export const contentFreeSpanProcessor: SpanProcessor = {
	onStart() {},
	onEnd(span) {
		for (const key of Object.keys(span.attributes)) if (!attributes.has(key)) delete span.attributes[key];
		span.events.length = 0;
		delete span.status.message;
	},
	async forceFlush() {},
	async shutdown() {},
};
