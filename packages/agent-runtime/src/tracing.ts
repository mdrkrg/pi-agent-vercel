import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import { context, propagation, SpanKind, SpanStatusCode, trace, type Attributes, type Span } from "@opentelemetry/api";

/** Stable names only: prompts, URLs, SQL, and error messages must never name spans. */
type Stage = "function.request" | "function.configure" | "function.handle" | "function.close"
	| "database.ready" | "submission.admit" | "worker.tick" | "worker.admission.recover" | "worker.discover"
	| "worker.discover.session" | "worker.run" | "worker.reconcile" | "job.claim"
	| "job.pass" | "job.metadata" | "job.authorize" | "job.session.open" | "job.harness.create"
	| "job.result.read" | "job.drive" | "job.settle" | "ownership.acquire"
	| "ownership.close" | "ownership.renew" | "ownership.renewal.wait" | "ownership.release";

/** Telemetry annotations must not replace an execution/cleanup error. */
export function annotateSpan(span: Span, attributes: Attributes): void {
	try { span.setAttributes(attributes); } catch { /* Observability is not execution authority. */ }
}

export function traceStage<T>(name: Stage, attributes: Attributes, run: (span: Span) => Promise<T>): Promise<T> {
	return trace.getTracer("pi-agent-vercel").startActiveSpan(name, { attributes }, async (span) => {
		try { return await run(span); }
		catch (error) {
			// recordException would export arbitrary provider/tool messages and stacks.
			try { span.setStatus({ code: SpanStatusCode.ERROR }); } catch { /* Keep the original error. */ }
			throw error;
		} finally { try { span.end(); } catch { /* Keep execution and cleanup semantics. */ } }
	});
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
	const parent = propagation.extract(context.active(), carrier);
	const method = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(req.method ?? "") ? req.method! : "OTHER";
	return context.with(parent, () => trace.getTracer("pi-agent-vercel").startActiveSpan("function.request", {
		kind: SpanKind.SERVER, attributes: { "http.request.method": method, "http.route": route(req.url) },
	}, async (span) => {
		try { return await run(); }
		catch (error) {
			try { span.setStatus({ code: SpanStatusCode.ERROR }); } catch { /* Preserve original error. */ }
			throw error;
		} finally {
			annotateSpan(span, { "http.response.status_code": res.statusCode });
			try { if (res.statusCode >= 500) span.setStatus({ code: SpanStatusCode.ERROR }); } catch { /* Best effort. */ }
			try { span.end(); } catch { /* Best effort. */ }
		}
	}));
}
