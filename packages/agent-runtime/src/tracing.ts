import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import { context, INVALID_SPAN_CONTEXT, isSpanContextValid, propagation, ROOT_CONTEXT, SpanKind, SpanStatusCode, trace, type Attributes, type Context, type Span, type SpanContext, type SpanOptions } from "@opentelemetry/api";

/** Stable names only: prompts, URLs, SQL, and error messages must never name spans. */
type Stage = "function.request" | "function.configure" | "function.handle" | "function.close"
	| "database.ready" | "submission.admit" | "worker.tick" | "worker.admission.recover" | "worker.discover"
	| "worker.discover.list" | "worker.discover.session" | "worker.discover.session.open"
	| "worker.discover.harness.create" | "worker.discover.publish" | "worker.run" | "worker.reconcile" | "job.claim"
	| "job.pass" | "job.metadata" | "job.authorize" | "job.session.open" | "job.harness.create"
	| "job.result.read" | "job.drive" | "job.settle" | "job.release" | "job.reschedule" | "ownership.acquire"
	| "ownership.close" | "ownership.renew" | "ownership.renewal.wait" | "ownership.release";

/** Telemetry annotations must not replace an execution/cleanup error. */
export function annotateSpan(span: Span, attributes: Attributes): void {
	try { span.setAttributes(attributes); } catch { /* Observability is not execution authority. */ }
}

function activeContext(): Context {
	try { return context.active(); } catch { return ROOT_CONTEXT; }
}

/** A failed span/context setup must still execute the callback exactly once. */
function withSpan<T>(name: Stage, options: SpanOptions, parent: Context, run: (span: Span) => Promise<T>, finish?: (span: Span) => void): Promise<T> {
	let span = trace.wrapSpanContext(INVALID_SPAN_CONTEXT);
	let active = parent;
	try {
		span = trace.getTracer("pi-agent-vercel").startSpan(name, options, parent);
		active = trace.setSpan(parent, span);
	} catch { /* Fall back to untraced execution. */ }
	const execute = async () => {
		try { return await run(span); }
		catch (error) {
			// recordException would export arbitrary provider/tool messages and stacks.
			try { span.setStatus({ code: SpanStatusCode.ERROR }); } catch { /* Keep the original error. */ }
			throw error;
		} finally {
			try { finish?.(span); } catch { /* Keep execution and cleanup semantics. */ }
			try { span.end(); } catch { /* Keep execution and cleanup semantics. */ }
		}
	};
	let execution: Promise<T> | undefined;
	try { context.with(active, () => { execution = execute(); }); }
	catch { /* A context manager may fail before or after invoking its callback. */ }
	return execution ?? execute();
}

export function traceStage<T>(name: Stage, attributes: Attributes, run: (span: Span) => Promise<T>): Promise<T> {
	return withSpan(name, { attributes }, activeContext(), run);
}

function functionParent(): Context {
	const parent = activeContext();
	try {
		const active = trace.getSpanContext(parent);
		if (active !== undefined && isSpanContextValid(active)) return parent;
		// Plain Node Functions expose their platform parent through this SDK bridge,
		// not necessarily through an active OpenTelemetry span. Never read headers here.
		const reader = (globalThis as typeof globalThis & {
			[key: symbol]: { get(): { telemetry?: { rootSpanContext?: SpanContext } } | undefined } | undefined;
		})[Symbol.for("@vercel/request-context")];
		const root = reader?.get()?.telemetry?.rootSpanContext;
		if (root !== undefined && isSpanContextValid(root)) return trace.setSpanContext(parent, { ...root, isRemote: true });
	} catch { /* Host telemetry cannot prevent request handling. */ }
	return parent;
}

function route(url: string | undefined): string {
	let pathname: string;
	try { pathname = new URL(url ?? "/", "http://localhost").pathname.replace(/\/+$/, ""); }
	catch { return "unmatched"; }
	if (pathname === "/api/worker" || pathname === "/api/sessions") return pathname;
	if (/^\/api\/sessions\/[^/]+\/messages$/.test(pathname)) return "/api/sessions/:id/messages";
	if (/^\/api\/sessions\/[^/]+\/fork$/.test(pathname)) return "/api/sessions/:id/fork";
	if (/^\/api\/submissions\/[^/]+$/.test(pathname)) return "/api/submissions/:id";
	if (/^\/api\/submissions\/[^/]+\/result$/.test(pathname)) return "/api/submissions/:id/result";
	return "unmatched";
}

export function traceFunctionRequest<T>(req: IncomingMessage, res: ServerResponse, run: () => Promise<T>): Promise<T> {
	// Only W3C trace context is accepted. Baggage/identity/auth headers cannot grant authority.
	const carrier: Record<string, string> = {};
	for (const name of ["traceparent", "tracestate"] satisfies (keyof IncomingHttpHeaders)[]) {
		const value = req.headers[name];
		if (typeof value === "string") carrier[name] = value;
	}
	let parent = functionParent();
	try { parent = propagation.extract(parent, carrier); } catch { /* Keep the host parent or run untraced. */ }
	const method = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(req.method ?? "") ? req.method! : "OTHER";
	return withSpan("function.request", {
		kind: SpanKind.SERVER, attributes: { "http.request.method": method, "http.route": route(req.url) },
	}, parent, run, (span) => {
		annotateSpan(span, { "http.response.status_code": res.statusCode });
		if (res.statusCode >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
	});
}
