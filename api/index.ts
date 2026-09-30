import type { IncomingMessage, ServerResponse } from "node:http";
import { handleRequest } from "../apps/vercel-service/src/service.ts";

/** Vercel Node Function entrypoint. Routing is delegated to the shared handler. */
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
	await handleRequest(req, res);
}
