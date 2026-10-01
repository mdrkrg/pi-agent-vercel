import type { IncomingMessage, ServerResponse } from "node:http";
import { createFunctionServiceFromEnv } from "../packages/agent-runtime/src/function-config.ts";

export default async function handler(req: IncomingMessage & { readonly body?: unknown }, res: ServerResponse): Promise<void> {
	let service;
	try { service = createFunctionServiceFromEnv(); await service.handle(req, res); }
	catch { if (!res.writableEnded) { res.statusCode = 500; res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ error: "Function configuration or database unavailable" })); } }
	finally { if (service !== undefined) await service.close(); }
}
