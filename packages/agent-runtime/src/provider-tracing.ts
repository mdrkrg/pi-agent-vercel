import { SpanStatusCode } from "@opentelemetry/api";
import type { AssistantMessageEvent, AssistantMessageEventStream, Models, ProviderRequestOptions } from "@earendil-works/pi-ai";
import { annotateSpan, traceStage } from "./tracing.ts";

/** Observe emission, not the harness consumer (which may await durable frame writes). */
function request(kind: "stream" | "deferred", signal: AbortSignal | undefined, dispatch: (headers: () => void) => AssistantMessageEventStream): AssistantMessageEventStream {
	let source: AssistantMessageEventStream | undefined;
	let dispatchError: unknown;
	let threw = false;
	const observation = traceStage("provider.request", { "agent.provider.request.kind": kind }, async (span) => {
		const started = performance.now();
		let ended = false;
		let firstContent = false;
		let firstText = false;
		let firstHeaders = false;
		const headers = () => {
			if (ended || firstHeaders) return;
			firstHeaders = true;
			annotateSpan(span, { "agent.provider.response_headers_ms": performance.now() - started });
		};
		try { source = dispatch(headers); }
		catch (error) {
			threw = true; dispatchError = error;
			annotateSpan(span, { "agent.provider.total_ms": performance.now() - started, "agent.provider.outcome": "error" });
			throw error;
		}
		const stream = source;
		const originalPush = stream.push;
		const observeEvent = (event: AssistantMessageEvent) => {
			if (ended) return;
			if ((event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta") && event.delta.length > 0) {
				if (!firstContent) {
					firstContent = true;
					annotateSpan(span, { "agent.provider.first_content_ms": performance.now() - started });
				}
				if (event.type === "text_delta" && !firstText) {
					firstText = true;
					annotateSpan(span, { "agent.provider.first_text_ms": performance.now() - started });
				}
			}
		};
		const push: typeof stream.push = function (this: AssistantMessageEventStream, event) {
			try { observeEvent(event); } catch { /* Pass the exact event through even if telemetry fails. */ }
			return originalPush.call(this, event);
		};
		// Published Models dispatches through an asynchronous lazy stream. No second
		// consumer, buffering, request, abort, or mutation of the event is introduced.
		try { stream.push = push; } catch { /* Frozen/custom streams retain completion timing only. */ }
		let cancel: (() => void) | undefined;
		const interrupted = new Promise<"interrupted">((resolve) => { cancel = () => resolve("interrupted"); });
		try {
			signal?.addEventListener("abort", cancel!, { once: true });
			if (signal?.aborted) cancel!();
			const result = await Promise.race([stream.result(), interrupted]);
			const outcome = result === "interrupted" ? "interrupted"
				: ["stop", "length", "toolUse", "error", "aborted", "deferred"].includes(result.stopReason) ? result.stopReason : "unknown";
			annotateSpan(span, {
				"agent.provider.outcome": outcome,
				"agent.provider.cancel_requested": signal?.aborted ?? false,
			});
			if (outcome === "error" || outcome === "aborted" || outcome === "interrupted") {
				try { span.setStatus({ code: SpanStatusCode.ERROR }); } catch { /* No exception contents. */ }
			}
		} catch (error) {
			annotateSpan(span, { "agent.provider.outcome": "error" });
			throw error;
		} finally {
			annotateSpan(span, { "agent.provider.total_ms": performance.now() - started });
			ended = true;
			signal?.removeEventListener("abort", cancel!);
			try { if (stream.push === push) stream.push = originalPush; } catch { /* Preserve the original stream. */ }
		}
	});
	void observation.catch(() => undefined);
	if (threw) throw dispatchError;
	return source!;
}

function responseOptions<T extends ProviderRequestOptions>(options: T | undefined, headers: () => void): T {
	return { ...options, onResponse: (response, model) => { headers(); return options?.onResponse?.(response, model); } } as T;
}

/** Decorate the published Models interface without changing auth/retry/effect semantics. */
export function tracedModels(models: Models): Models {
	const streams: Pick<Models, "stream" | "streamSimple" | "streamDeferred" | "complete" | "completeSimple" | "fetchDeferred"> = {
		stream: (model, transcript, options) => request("stream", options?.signal, (headers) => models.stream(model, transcript, responseOptions(options, headers))),
		streamSimple: (model, transcript, options) => request("stream", options?.signal, (headers) => models.streamSimple(model, transcript, responseOptions(options, headers))),
		streamDeferred: (model, handle, options) => request("deferred", options?.signal, (headers) => models.streamDeferred(model, handle, responseOptions(options, headers))),
		complete: async (model, transcript, options) => streams.stream(model, transcript, options).result(),
		completeSimple: async (model, transcript, options) => streams.streamSimple(model, transcript, options).result(),
		fetchDeferred: async (model, handle, options) => streams.streamDeferred(model, handle, options).result(),
	};
	return new Proxy(models, {
		get(target, key) {
			if (Object.hasOwn(streams, key)) return streams[key as keyof typeof streams];
			const value = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}
