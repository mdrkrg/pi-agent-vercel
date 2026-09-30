import { createServer } from "node:http";
import { getDefaultService, handleRequest } from "./service.ts";

const port = Number(process.env.PORT ?? 3000);
const service = getDefaultService();
await service.ready();
const server = createServer((req, res) => {
	void handleRequest(req, res, service);
});

const close = async () => {
	server.close();
	await service.close();
};
process.once("SIGINT", () => void close().then(() => process.exit(0)));
process.once("SIGTERM", () => void close().then(() => process.exit(0)));
server.listen(port, () => {
	console.log(`Local Vercel simulator listening on http://localhost:${port}`);
});
