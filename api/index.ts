import type { IncomingMessage, ServerResponse } from "node:http";
import { createFunctionServiceFromEnv } from "../packages/agent-runtime/src/function-config.ts";
import { reportFunctionFailure } from "../packages/agent-runtime/src/function-diagnostics.ts";

export default async function handler(req: IncomingMessage & { readonly body?: unknown }, res: ServerResponse): Promise<void> {
	const started = performance.now();
	let service;
	try { service = createFunctionServiceFromEnv(); await service.handle(req, res); }
	catch (error) {
		reportFunctionFailure(error, "entry", performance.now() - started);
		if (!res.writableEnded) { res.statusCode = 500; res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ error: "Function configuration or database unavailable" })); }
	}
	finally {
		if (service !== undefined) {
			try { await service.close(); }
			catch (error) {
				reportFunctionFailure(error, "cleanup", performance.now() - started);
				throw new Error("Function cleanup failed");
			}
		}
	}
}
