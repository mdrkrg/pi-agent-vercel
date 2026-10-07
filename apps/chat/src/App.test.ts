import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App.svelte";
import { saveConversation } from "./storage.ts";
import documentHtml from "../index.html?raw";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const result = (text: string, status: "completed" | "failed" | "aborted" = "completed") => ({ result: { status }, output: { type: "message", message: { role: "assistant", content: [{ type: "text", text }] } } });
beforeEach(() => { sessionStorage.clear(); vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible"); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
async function connect() {
	await fireEvent.input(screen.getByLabelText("Access token"), { target: { value: "private-token" } });
	await fireEvent.click(screen.getByRole("button", { name: "Connect" }));
}
async function send(prompt: string) {
	await fireEvent.input(screen.getByLabelText("Message"), { target: { value: prompt } });
	await fireEvent.click(screen.getByRole("button", { name: "Send" }));
}
describe("Svelte live chat", () => {
	it("keeps technical explanations in a closed FAQ below the composer", () => {
		const page = render(App);
		expect(documentHtml).toContain('<html lang="en">');
		expect(screen.getByRole("heading", { name: "Pi Chat" })).toBeTruthy();
		expect(screen.queryByText("DURABLE AGENT")).toBeNull();
		expect(screen.getByLabelText("Access token")).toBeTruthy();
		expect(screen.queryByText(/POC_API_TOKEN/)).toBeNull();
		expect(screen.queryByText(/worker and scheduler/)).toBeNull();
		expect(screen.queryByText(/plain text/)).toBeNull();
		expect(screen.queryByRole("region", { name: "Frequently asked questions" })).toBeNull();
		const help = screen.getByRole("button", { name: "Frequently asked questions" });
		expect(page.container.querySelector("main")?.lastElementChild?.contains(help)).toBe(true);
	});
	it("renders two contextual rounds safely and freezes earlier output without invoking worker", async () => {
		let round = 0;
		const request = vi.fn<typeof fetch>().mockImplementation(async (path) => {
			if (path === "/api/sessions") return json({ session: { id: "session" } });
			if (path === "/api/sessions/session/messages") return json({ submission: { id: `submission-${++round}` } }, 202);
			if (String(path).endsWith("/result")) return json(result(String(path).includes("submission-1") ? "<img src=x onerror=alert(1)>" : "second answer"));
			return json({ submission: { id: "id", status: "completed" }, result: { status: "completed" } });
		});
		vi.stubGlobal("fetch", request);
		const page = render(App);
		await connect();
		await fireEvent.click(screen.getByRole("button", { name: "New chat" }));
		await waitFor(() => expect((screen.getByLabelText("Message") as HTMLTextAreaElement).disabled).toBe(false));
		await send("first question");
		await screen.findByText("<img src=x onerror=alert(1)>");
		expect(page.container.querySelector("img")).toBeNull();
		await waitFor(() => expect((screen.getByLabelText("Message") as HTMLTextAreaElement).disabled).toBe(false));
		const firstReads = request.mock.calls.filter(([path]) => String(path).includes("submission-1")).length;
		await send("second question"); await screen.findByText("second answer");
		expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeTruthy();
		expect(request.mock.calls.filter(([path]) => String(path).includes("submission-1"))).toHaveLength(firstReads);
		expect(request.mock.calls.some(([path]) => String(path).includes("worker"))).toBe(false);
		expect(sessionStorage.getItem("pi-live-chat:v1")).not.toContain("private-token");
		expect(sessionStorage.getItem("pi-live-chat:v1")).not.toContain("second answer");
	});
	it("restores terminal outputs only after auth and visibility, showing failed native results", async () => {
		saveConversation(sessionStorage, { sessionId: "s", draft: "", turns: [{ key: "k", prompt: "question", submissionId: "id", terminal: true }] });
		const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
		const request = vi.fn<typeof fetch>().mockResolvedValue(json(result("partial reply", "failed")));
		vi.stubGlobal("fetch", request); render(App);
		expect(request).not.toHaveBeenCalled();
		await connect(); expect(request).not.toHaveBeenCalled();
		visibility.mockReturnValue("visible");
		document.dispatchEvent(new Event("visibilitychange"));
		await screen.findByText("partial reply"); await screen.findByText("Turn failed");
		expect(request.mock.calls.map(([path]) => path)).toEqual(["/api/submissions/id/result"]);
	});
	it("treats a 409 result as unfinished and keeps the composer locked until frozen output arrives", async () => {
		saveConversation(sessionStorage, { sessionId: "s", draft: "", turns: [{ key: "k", prompt: "question", submissionId: "id", terminal: false }] });
		let reads = 0;
		const request = vi.fn<typeof fetch>().mockImplementation(async (path) => String(path).endsWith("/result")
			? ++reads === 1 ? json({}, 409) : json(result("finished"))
			: json({ submission: { id: "id", status: "completed" }, result: { status: "completed" } }));
		vi.stubGlobal("fetch", request); render(App); await connect();
		await screen.findByText("Request conflict or result not ready.");
		expect((screen.getByLabelText("Message") as HTMLTextAreaElement).disabled).toBe(true);
		await fireEvent.click(screen.getByRole("button", { name: "Refresh reply" }));
		await screen.findByText("finished");
		await waitFor(() => expect((screen.getByLabelText("Message") as HTMLTextAreaElement).disabled).toBe(false));
	});
	it("polls running work to completion without another send", async () => {
		saveConversation(sessionStorage, { sessionId: "s", draft: "", turns: [{ key: "k", prompt: "question", submissionId: "id", terminal: false }] });
		let reads = 0;
		const request = vi.fn<typeof fetch>().mockImplementation(async (path) => {
			if (String(path).endsWith("/result")) return json(result("automatic reply"));
			return ++reads === 1 ? json({ submission: { id: "id", status: "running" } })
				: json({ submission: { id: "id", status: "completed" }, result: { status: "completed" } });
		});
		vi.stubGlobal("fetch", request); render(App); await connect();
		await screen.findByText("Generating reply");
		await screen.findByText("automatic reply", {}, { timeout: 3500 });
		expect(request.mock.calls.map(([path]) => path)).toEqual(["/api/submissions/id", "/api/submissions/id", "/api/submissions/id/result"]);
	});
	it("pauses open-operation polling while hidden and immediately resumes on visibility", async () => {
		saveConversation(sessionStorage, { sessionId: "s", draft: "", turns: [{ key: "k", prompt: "question", submissionId: "id", terminal: false }] });
		let reads = 0;
		const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
		const request = vi.fn<typeof fetch>().mockImplementation(async (path) => {
			if (String(path).endsWith("/result")) return json(result("resumed reply"));
			return ++reads === 1 ? json({ submission: { id: "id", status: "running" } })
				: json({ submission: { id: "id", status: "completed" }, result: { status: "completed" } });
		});
		vi.stubGlobal("fetch", request); render(App); await connect(); await screen.findByText("Generating reply");
		visibility.mockReturnValue("hidden"); await fireEvent(document, new Event("visibilitychange"));
		await new Promise((resolve) => setTimeout(resolve, 2200));
		expect(request).toHaveBeenCalledTimes(1);
		visibility.mockReturnValue("visible"); await fireEvent(document, new Event("visibilitychange"));
		await screen.findByText("resumed reply");
	});
	it("requires fresh credentials after a read 401 while retaining the submission identity", async () => {
		saveConversation(sessionStorage, { sessionId: "s", draft: "", turns: [{ key: "k", prompt: "question", submissionId: "id", terminal: false }] });
		const request = vi.fn<typeof fetch>().mockResolvedValue(json({}, 401));
		vi.stubGlobal("fetch", request); render(App); await connect();
		await screen.findByText("Access token is invalid or lacks permission. Please enter it again.");
		expect(screen.getByText("Connect to view the reply.")).toBeTruthy();
		expect(sessionStorage.getItem("pi-live-chat:v1")).toContain('"submissionId":"id"');
	});
});
