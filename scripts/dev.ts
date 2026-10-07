import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import concurrently from "concurrently";
import { acquireDevLock, chooseEngine, DEV_API_TOKEN, DevDatabase, devConfig, fauxEnvironment } from "./dev-stack.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const [action, ...flags] = process.argv.slice(2);
const controller = new AbortController();
const interrupt = () => controller.abort();
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, interrupt);

async function main(): Promise<void> {
	if (!["start", "stop", "reset"].includes(action ?? "") || flags.some((flag) => flag !== "--yes") || (action !== "reset" && flags.length > 0)) {
		throw new Error("Usage: pnpm dev:faux | pnpm dev:stop | pnpm dev:reset [--yes]");
	}
	const config = devConfig(root, process.env);
	if (action === "reset" && !flags.includes("--yes")) {
		if (!process.stdin.isTTY) throw new Error("dev:reset requires interactive confirmation; automation must explicitly pass --yes.");
		const input = createInterface({ input: process.stdin, output: process.stdout });
		try {
			const answer = await input.question(`This will delete local development data for ${config.namespace}. Type ${config.namespace} to confirm: `, { signal: controller.signal });
			if (answer !== config.namespace) { console.log("Not confirmed; no resources were modified."); return; }
		} finally { input.close(); }
	}
	controller.signal.throwIfAborted();
	const release = await acquireDevLock(config);
	let database: DevDatabase | undefined;
	try {
		const engine = await chooseEngine(process.env);
		database = new DevDatabase(config, engine);
		if (action === "stop") { await database.stop(); console.log("Development database stopped; data retained."); return; }
		if (action === "reset") { await database.reset(); console.log("Dedicated development container and data removed. Clear old local conversation records in your browser."); return; }
		console.log(`Starting the local FAUX stack (${engine}); waiting for PostgreSQL…`);
		await database.start(controller.signal);
		controller.signal.throwIfAborted();
		console.log(`UI: http://127.0.0.1:${config.uiPort} · API: http://127.0.0.1:${config.servicePort}`);
		console.log(`Access token: ${DEV_API_TOKEN} (local FAUX only)`);
		console.log("Ctrl+C stops the backend, UI and database together; database data is retained.");
		const env = fauxEnvironment(config, process.env);
		const services = concurrently([
			{ name: "service", command: "pnpm run dev:service", env },
			{ name: "ui", command: `pnpm run dev:ui --port ${config.uiPort}`, env },
		], { cwd: config.root, prefix: "name", prefixColors: ["cyan", "magenta"], killOthersOn: ["success", "failure"], killTimeout: 15_000 });
		try { await services.result; }
		catch { if (!controller.signal.aborted) throw new Error("The backend or UI exited; the other process has also been stopped."); }
	} finally {
		try { await database?.stopStarted(); }
		finally { await release(); }
	}
}

try { await main(); }
catch (error) {
	if (!(controller.signal.aborted && error instanceof Error && error.name === "AbortError")) {
		console.error(error instanceof Error ? error.message : "Development script failed.");
		process.exitCode = 1;
	}
} finally {
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.off(signal, interrupt);
}
