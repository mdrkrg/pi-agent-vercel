import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";

const attributes = new Set([
	"http.request.method", "http.route", "http.response.status_code",
	"agent.submission.id", "agent.submission.created", "agent.operation.id",
	"agent.job.id", "agent.job.attempt", "agent.job.status", "agent.job.eligible_delay_ms", "agent.job.age_ms",
	"agent.invocation.budget_ms", "agent.pass.budget_ms", "agent.invocation.exhausted",
	"agent.worker.phase", "agent.worker.deadline_phase", "agent.drive.outcome",
	"agent.admission.processed.count", "agent.admission.error.count", "agent.discovered.count", "agent.driven.count",
	"agent.reconcile.processed.count", "agent.reconcile.error.count", "agent.discovery.session.count", "agent.discovery.open.count",
	"db.operation.name", "agent.db.pool.total", "agent.db.pool.idle", "agent.db.pool.waiting",
	"agent.db.query.count", "agent.db.query.total_ms", "agent.db.query.error.count",
	"agent.db.acquire.count", "agent.db.acquire.total_ms", "agent.db.acquire.error.count",
	"agent.db.transaction.count", "agent.db.transaction.total_ms", "agent.db.transaction.error.count",
	"agent.provider.request.kind", "agent.provider.first_content_ms", "agent.provider.first_text_ms",
	"agent.provider.response_headers_ms", "agent.provider.total_ms", "agent.provider.outcome", "agent.provider.cancel_requested",
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
