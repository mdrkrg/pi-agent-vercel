import { describe, expect, it, vi } from "vitest";
import { ApiError, ChatApi, outputText, permanentReadError, pollInterval, statusText } from "./api.ts";

const signal = () => new AbortController().signal;
describe("chat API", () => {
	it("uses only same-origin API routes and encodes resource IDs", async () => {
		const request = vi.fn<typeof fetch>().mockImplementation(async () => new Response("{}"));
		const api = new ChatApi(request);
		await api.createSession("private-token", signal());
		await api.submit("session/a", "stable-key", " exact prompt ", "private-token", signal());
		await api.view("submission/b", "private-token", signal());
		await api.result("submission/b", "private-token", signal());
		expect(request.mock.calls.map(([path]) => path)).toEqual(["/api/sessions", "/api/sessions/session%2Fa/messages", "/api/submissions/submission%2Fb", "/api/submissions/submission%2Fb/result"]);
		const options = request.mock.calls[1]![1]!;
		expect(new Headers(options.headers).get("authorization")).toBe("Bearer private-token");
		expect(new Headers(options.headers).get("idempotency-key")).toBe("stable-key");
		expect(options.body).toBe(JSON.stringify({ prompt: " exact prompt " }));
		expect(options).toMatchObject({ cache: "no-store", redirect: "error" });
	});
	it("does not auto-retry writes or expose response bodies", async () => {
		const request = vi.fn<typeof fetch>().mockResolvedValue(new Response("secret server diagnostics", { status: 500 }));
		await expect(new ChatApi(request).createSession("token", signal())).rejects.toThrow("Service unavailable");
		expect(request).toHaveBeenCalledTimes(1);
		request.mockResolvedValue(new Response("deployment protection HTML"));
		await expect(new ChatApi(request).view("id", "token", signal())).rejects.toThrow("Network error");
	});
	it("distinguishes unfinished/conflicting, unauthorized and transient reads", () => {
		expect(permanentReadError(new ApiError(401))).toBe(true);
		expect(permanentReadError(new ApiError(404))).toBe(true);
		expect(pollInterval(new ApiError(409), false)).toBe(10_000);
		expect(pollInterval(new ApiError(429), false)).toBe(10_000);
		expect(pollInterval(new ApiError(500), false)).toBe(10_000);
		expect(pollInterval(new ApiError(404), false)).toBe(false);
		expect(pollInterval(null, false)).toBe(2_000);
		expect(pollInterval(null, true)).toBe(10_000);
	});
	it("extracts only assistant text, leaving thinking/tools and missing outputs explicit", () => {
		expect(outputText({ result: { status: "completed" }, output: { type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "private" }, { type: "text", text: "hello" }, { type: "toolCall", name: "tool" }, { type: "text", text: "world" }] } } })).toBe("hello\nworld");
		expect(outputText({ result: { status: "failed" } })).toBe("No assistant text is available for this turn.");
		expect(outputText({ result: { status: "completed" }, output: { type: "message", message: { role: "user", content: "not a reply" } } })).toBe("No assistant text is available for this turn.");
		expect(statusText({ submission: { id: "id", status: "waiting" }, operation: { status: "waiting", retryAt: 1000 } })).toContain("Waiting to retry");
	});
});
