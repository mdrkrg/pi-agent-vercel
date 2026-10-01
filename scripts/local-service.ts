import { createServer } from "node:http";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/pi-agent-core/harness/context";
import { createFunctionServiceFromEnv } from "../packages/agent-runtime/src/function-config.ts";

const intervalMs = Number(process.env.AGENT_POLL_MS ?? 1_000);
const port = Number(process.env.PORT ?? 3000);
if (!Number.isSafeInteger(intervalMs) || intervalMs < 100 || !Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error("Invalid local service port or polling interval");
const controller = new AbortController();
// Validate configuration before listening; connections open only on the first query.
await createFunctionServiceFromEnv().close();
const server = createServer((req, res) => {
	void (async () => {
		const service = createFunctionServiceFromEnv();
		try { await service.handle(req, res); }
		finally { await service.close(); }
	})().catch(() => { if (!res.writableEnded) { res.statusCode = 500; res.end(JSON.stringify({ error: "Service unavailable" })); } });
});
server.listen(port, "127.0.0.1", () => {
	const address = server.address();
	if (address !== null && typeof address === "object") process.stdout.write(`Function PoC listening on http://127.0.0.1:${address.port}\n`);
});
const stop = () => { controller.abort(); server.close(); };
process.once("SIGTERM", stop); process.once("SIGINT", stop);
while (!controller.signal.aborted) {
	const service = createFunctionServiceFromEnv();
	try { await service.ready(); await service.worker.tick(withAbortSignal(controller.signal, BACKGROUND_CONTEXT)); }
	catch (error) { if (!controller.signal.aborted) process.stderr.write(`${error instanceof Error ? error.message : "Worker failed"}\n`); }
	finally { await service.close(); }
	if (!controller.signal.aborted) await new Promise<void>((resolve) => {
		const done = () => { clearTimeout(timer); controller.signal.removeEventListener("abort", done); resolve(); };
		const timer = setTimeout(done, intervalMs); controller.signal.addEventListener("abort", done, { once: true });
	});
}
