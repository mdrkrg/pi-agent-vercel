// Browser-facing shapes only; Pi remains the source of operation semantics.
export type SubmissionView = {
	submission: { id: string; status: "accepted" | "running" | "waiting" | "completed" | "failed" | "cancelled" };
	operation?: { status: string; retryAt?: number };
	result?: { status: "completed" | "failed" | "aborted" };
};
export type ResultView = {
	result: { status: "completed" | "failed" | "aborted"; error?: { code?: string; message?: string } };
	output?: { type: string; message?: { role: string; content: unknown } };
};

export class ApiError extends Error {
	constructor(readonly status: number) {
		super(status === 401 ? "Access token is invalid or expired. Please enter it again."
			: status === 403 ? "This token does not have access."
			: status === 404 ? "Resource not found or access denied."
			: status === 409 ? "Request conflict or result not ready."
			: status >= 500 ? "Service unavailable; submitted work may still be running."
			: `Request rejected (HTTP ${status}).`);
	}
}

export class ChatApi {
	constructor(private readonly request: typeof fetch = (...args) => fetch(...args)) {}
	private async json<T>(path: string, token: string, options: RequestInit = {}): Promise<T> {
		const headers = new Headers(options.headers);
		headers.set("Authorization", `Bearer ${token}`);
		if (options.body !== undefined) headers.set("Content-Type", "application/json");
		const timeout = AbortSignal.timeout(25_000);
		const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
		try {
			const response = await this.request(path, { ...options, headers, signal, cache: "no-store", redirect: "error" });
			if (!response.ok) throw new ApiError(response.status);
			return await response.json() as T;
		} catch (error) {
			if (error instanceof ApiError || options.signal?.aborted) throw error;
			// Do not expose server HTML, credentials or request bodies in diagnostics.
			throw new Error("Network error or request timed out. Background work is not cancelled.");
		}
	}
	createSession(token: string, signal: AbortSignal): Promise<{ session: { id: string } }> {
		return this.json("/api/sessions", token, { method: "POST", body: "{}", signal });
	}
	submit(sessionId: string, key: string, prompt: string, token: string, signal: AbortSignal): Promise<{ submission: { id: string } }> {
		return this.json(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, token, {
			method: "POST", headers: { "Idempotency-Key": key }, body: JSON.stringify({ prompt }), signal,
		});
	}
	view(id: string, token: string, signal: AbortSignal): Promise<SubmissionView> {
		return this.json(`/api/submissions/${encodeURIComponent(id)}`, token, { signal });
	}
	result(id: string, token: string, signal: AbortSignal): Promise<ResultView> {
		return this.json(`/api/submissions/${encodeURIComponent(id)}/result`, token, { signal });
	}
}

export function outputText(view: ResultView): string {
	const message = view.output?.type === "message" ? view.output.message : undefined;
	if (message?.role !== "assistant") return "No assistant text is available for this turn.";
	if (typeof message.content === "string") return message.content || "The assistant returned empty text.";
	if (!Array.isArray(message.content)) return "No assistant text is available for this turn.";
	const text = message.content.filter((part): part is { type: "text"; text: string } =>
		part !== null && typeof part === "object" && part.type === "text" && typeof part.text === "string")
		.map((part) => part.text).join("\n");
	return text || "No assistant text is available for this turn.";
}

export function permanentReadError(error: unknown): boolean {
	return error instanceof ApiError && error.status >= 400 && error.status < 500 && ![409, 429].includes(error.status);
}

export function pollInterval(error: unknown, waiting: boolean): number | false {
	return permanentReadError(error) ? false : error || waiting ? 10_000 : 2_000;
}

export function statusText(view?: SubmissionView): string {
	if (view?.operation?.status === "aborting") return "Finalizing cancellation";
	if (view?.operation?.retryAt !== undefined) return `Waiting to retry · ${new Date(view.operation.retryAt).toLocaleTimeString("en-US")}`;
	const labels = { accepted: "Queued", running: "Generating reply", waiting: "Waiting to resume", completed: "Completed", failed: "Failed", cancelled: "Cancelled" };
	return view ? labels[view.submission.status] : "Checking reply";
}
