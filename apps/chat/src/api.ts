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
		super(status === 401 ? "密钥无效或已过期，请重新填写。"
			: status === 403 ? "这把密钥没有访问权限。"
			: status === 404 ? "资源不存在或无权访问。"
			: status === 409 ? "请求冲突或结果尚未完成。"
			: status >= 500 ? "服务暂时不可用；已提交的任务可能仍在运行。"
			: `请求被拒绝（HTTP ${status}）。`);
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
			throw new Error("网络异常或请求超时；后台任务不会因此取消。");
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
	if (message?.role !== "assistant") return "本轮没有可显示的助手文本。";
	if (typeof message.content === "string") return message.content || "助手返回了空文本。";
	if (!Array.isArray(message.content)) return "本轮没有可显示的助手文本。";
	const text = message.content.filter((part): part is { type: "text"; text: string } =>
		part !== null && typeof part === "object" && part.type === "text" && typeof part.text === "string")
		.map((part) => part.text).join("\n");
	return text || "本轮没有可显示的助手文本。";
}

export function permanentReadError(error: unknown): boolean {
	return error instanceof ApiError && error.status >= 400 && error.status < 500 && ![409, 429].includes(error.status);
}

export function pollInterval(error: unknown, waiting: boolean): number | false {
	return permanentReadError(error) ? false : error || waiting ? 10_000 : 2_000;
}

export function statusText(view?: SubmissionView): string {
	if (view?.operation?.status === "aborting") return "正在终结取消请求";
	if (view?.operation?.retryAt !== undefined) return `重试等待 · ${new Date(view.operation.retryAt).toLocaleTimeString()}`;
	const labels = { accepted: "排队中", running: "回复中", waiting: "等待继续", completed: "完成", failed: "失败", cancelled: "已取消" };
	return view ? labels[view.submission.status] : "正在查看回复";
}
