import "../packages/agent-runtime/src/telemetry-bootstrap.ts";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createFunctionServiceFromEnv } from "../packages/agent-runtime/src/function-config.ts";
import { reportFunctionFailure } from "../packages/agent-runtime/src/function-diagnostics.ts";
import { traceFunctionRequest, traceStage } from "../packages/agent-runtime/src/tracing.ts";

export default async function handler(req: IncomingMessage & { readonly body?: unknown }, res: ServerResponse): Promise<void> {
	const started = performance.now();
	await traceFunctionRequest(req, res, async () => {
		let service;
		try {
			service = await traceStage("function.configure", {}, async () => createFunctionServiceFromEnv());
			await traceStage("function.handle", {}, () => service!.handle(req, res));
		} catch (error) {
			reportFunctionFailure(error, "entry", performance.now() - started);
			if (!res.writableEnded) { res.statusCode = 500; res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ error: "Function configuration or database unavailable" })); }
		} finally {
			if (service !== undefined) {
				try { await traceStage("function.close", {}, () => service!.close()); }
				catch (error) {
					reportFunctionFailure(error, "cleanup", performance.now() - started);
					throw new Error("Function cleanup failed");
				}
			}
		}
	});
}
