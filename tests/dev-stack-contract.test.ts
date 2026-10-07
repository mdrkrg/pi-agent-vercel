import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireDevLock, checkPorts, chooseEngine, DEV_API_TOKEN, DevDatabase, devConfig, DEV_IMAGE, fauxEnvironment, type DevConfig, type Execute } from "../scripts/dev-stack.ts";

let root: string;
let config: DevConfig;
async function listen(server: Server): Promise<number> {
	return new Promise((done) => server.listen(0, "127.0.0.1", () => done((server.address() as { port: number }).port)));
}
async function close(server: Server): Promise<void> {
	await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
}
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "pi-dev-contract-"));
	const servers = [createServer(), createServer(), createServer()];
	try {
		const ports = await Promise.all(servers.map(listen));
		config = devConfig(root, { DEV_DB_PORT: String(ports[0]), DEV_SERVICE_PORT: String(ports[1]), DEV_UI_PORT: String(ports[2]) });
	} finally { await Promise.all(servers.map(close)); }
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function fakeDatabase() {
	const labels = { "io.pi-agent-vercel.dev.owner": config.root, "io.pi-agent-vercel.dev.scope": config.namespace };
	const containerInfo = () => ({
		Id: "owned-id", Config: { Image: DEV_IMAGE, Labels: { ...labels } }, State: { Running: true },
		Mounts: [{ Type: "volume", Name: config.volume, Destination: "/var/lib/postgresql/data" }],
		HostConfig: { PortBindings: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: String(config.dbPort) }] } },
	});
	let container: ReturnType<typeof containerInfo> | undefined;
	let volume: { Labels: Record<string, string> } | undefined;
	let ready = true;
	const run = vi.fn<Execute>().mockImplementation(async (_engine, args) => {
		if (args[1] === "inspect") {
			const value = args[0] === "container" ? container : volume;
			return value ? { code: 0, stdout: JSON.stringify([value]) } : { code: 125, stdout: "[]" };
		}
		if (args[0] === "volume" && args[1] === "create") { volume = { Labels: { ...labels } }; return { code: 0, stdout: config.volume }; }
		if (args[0] === "run") {
			container = containerInfo();
			for (let index = 0; index < args.length; index++) {
				if (args[index] !== "--label") continue;
				const [key, ...value] = args[index + 1]!.split("=");
				(container.Config.Labels as Record<string, string>)[key!] = value.join("=");
			}
			return { code: 0, stdout: container.Id };
		}
		if (args[0] === "start") container!.State.Running = true;
		if (args[0] === "stop") container!.State.Running = false;
		if (args[0] === "rm") container = undefined;
		if (args[0] === "volume" && args[1] === "rm") volume = undefined;
		if (args[0] === "exec") return { code: ready ? 0 : 1, stdout: "" };
		return { code: 0, stdout: "" };
	});
	return {
		run, db: new DevDatabase(config, "podman", run),
		get container() { return container; }, set container(value) { container = value; },
		get volume() { return volume; }, set volume(value) { volume = value; },
		setReady(value: boolean) { ready = value; },
	};
}

describe("local FAUX runner configuration", () => {
	it("uses PostgreSQL 16 and rejects invalid/conflicting ports or unsafe resource names", () => {
		expect(DEV_IMAGE).toBe("docker.io/library/postgres:16");
		expect(devConfig(root, {})).toMatchObject({ dbPort: 55432, servicePort: 3080, uiPort: 5173, container: "pi-agent-vercel-faux-db", volume: "pi-agent-vercel-faux-pgdata" });
		for (const env of [{ DEV_DB_PORT: "0" }, { DEV_UI_PORT: "70000" }, { DEV_DB_PORT: "3080" }, { DEV_STACK_NAME: "--rm all" }]) {
			expect(() => devConfig(root, env)).toThrow();
		}
	});
	it("overrides cloud connection, real-provider mode, auth, ports and execution budgets", () => {
		const env = fauxEnvironment(config, { DATABASE_URL: "postgresql://never-connect.invalid/production", PORT: "9999", POC_API_TOKEN: "not-used", AGENT_PASS_MS: "999999" });
		expect(env.DATABASE_URL).toBe(`postgresql://postgres:local-faux-only@127.0.0.1:${config.dbPort}/pi_chat_faux`);
		expect(env).toMatchObject({ POC_FAUX_RESPONSE: "This is a fixed FAUX response.", POC_API_TOKEN: "local-api", CRON_SECRET: "local-worker", AGENT_PASS_MS: "45000", AGENT_INVOCATION_MS: "55000", PGSSLMODE: "disable" });
		expect(env.POC_API_TOKEN).toBe(DEV_API_TOKEN);
		expect(env.DEV_SERVICE_PORT).toBe(String(config.servicePort));
		expect(env.PORT).toBe(String(config.servicePort));
	});
	it("prefers Podman and falls back to an available local Docker context", async () => {
		const run = vi.fn<Execute>().mockResolvedValue({ code: 0, stdout: "" });
		expect(await chooseEngine({}, run)).toBe("podman");
		run.mockImplementation(async (engine, args) => engine === "podman" ? { code: -1, stdout: "" }
			: { code: 0, stdout: args[0] === "context" ? "unix:///var/run/docker.sock" : "" });
		expect(await chooseEngine({}, run)).toBe("docker");
	});
	it("rejects remote engines, bad selectors and unavailable runtimes without resource actions", async () => {
		const run = vi.fn<Execute>();
		await expect(chooseEngine({ DOCKER_HOST: "tcp://remote:2375" }, run)).rejects.toThrow("local container engine");
		await expect(chooseEngine({ DEV_CONTAINER_ENGINE: "shell" }, run)).rejects.toThrow("podman or docker");
		expect(run).not.toHaveBeenCalled();
		run.mockResolvedValue({ code: 0, stdout: "ssh://remote" });
		await expect(chooseEngine({ DEV_CONTAINER_ENGINE: "docker" }, run)).rejects.toThrow("local socket");
		expect(run.mock.calls.some(([, args]) => args[0] === "ps")).toBe(false);
		run.mockResolvedValue({ code: -1, stdout: "" });
		await expect(chooseEngine({}, run)).rejects.toThrow("No local Podman/Docker engine");
	});
	it("serializes commands without background PID files and releases its lock", async () => {
		const release = await acquireDevLock(config);
		await expect(acquireDevLock(config)).rejects.toThrow("Development stack is locked");
		await release();
		await (await acquireDevLock(config))();
	});
	it("requires explicit reset confirmation before touching resources in non-interactive usage", async () => {
		const script = fileURLToPath(new URL("../scripts/dev.ts", import.meta.url));
		const child = spawn(process.execPath, ["--import", "tsx", script, "reset"], {
			env: { ...process.env, DEV_STACK_NAME: "pi-dev-contract-confirmation", DEV_DB_PORT: "55432", DEV_SERVICE_PORT: "3080", DEV_UI_PORT: "5173" },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stderr = ""; child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
		const exit = await new Promise<number | null>((done, reject) => { child.once("error", reject); child.once("close", done); });
		expect(exit).toBe(1);
		expect(stderr).toContain("dev:reset requires interactive confirmation");
	});
	it("reports occupied ports without stopping another process", async () => {
		const other = createServer();
		try {
			const busy = await listen(other);
			await expect(checkPorts({ ...config, uiPort: busy })).rejects.toThrow("Existing processes will not be stopped");
			expect(other.listening).toBe(true);
		} finally { await close(other); }
	});
});

describe("owned development PostgreSQL lifecycle", () => {
	it("creates a labelled, loopback-only DB, stops without deleting, and reuses data on restart", async () => {
		const fake = fakeDatabase();
		await fake.db.start(new AbortController().signal);
		const run = fake.run.mock.calls.find(([, args]) => args[0] === "run")![1];
		expect(run).toContain(`127.0.0.1:${config.dbPort}:5432`);
		expect(run).toContain(`io.pi-agent-vercel.dev.owner=${config.root}`);
		expect(run).toContain(`type=volume,source=${config.volume},target=/var/lib/postgresql/data`);
		expect(run).toContain("--cgroupns=host");
		expect(run).not.toContain("--rm");
		await fake.db.stopStarted();
		expect(fake.container?.State.Running).toBe(false);
		expect(fake.volume).toBeDefined();
		await fake.db.start(new AbortController().signal); await fake.db.stopStarted();
		expect(fake.run.mock.calls.filter(([, args]) => args[0] === "run")).toHaveLength(1);
		expect(fake.run.mock.calls.filter(([, args]) => args[0] === "start")).toHaveLength(1);
		expect(fake.run.mock.calls.some(([, args]) => args.includes("rm"))).toBe(false);
	});
	it("supports Docker without Podman-only flags", async () => {
		const fake = fakeDatabase();
		const db = new DevDatabase(config, "docker", fake.run);
		await db.start(new AbortController().signal); await db.stopStarted();
		expect(fake.run.mock.calls.find(([, args]) => args[0] === "run")![1]).not.toContain("--cgroupns=host");
	});
	it("is idempotent for stop/reset when resources are absent", async () => {
		const fake = fakeDatabase(); await fake.db.stop(); await fake.db.reset();
		expect(fake.run.mock.calls.every(([, args]) => args[1] === "inspect")).toBe(true);
	});
	it("refuses an active DB or changed port/image rather than taking it over", async () => {
		const fake = fakeDatabase(); await fake.db.start(new AbortController().signal);
		await expect(new DevDatabase(config, "podman", fake.run).start(new AbortController().signal)).rejects.toThrow("refusing to take over an active container");
		await fake.db.stopStarted();
		fake.container!.Config.Image = "other-image";
		await expect(fake.db.start(new AbortController().signal)).rejects.toThrow("image or port");
	});
	it("validates all ownership before stop/reset and never deletes foreign resources", async () => {
		const fake = fakeDatabase(); await fake.db.start(new AbortController().signal); await fake.db.stopStarted();
		fake.volume!.Labels["io.pi-agent-vercel.dev.owner"] = "/other-checkout";
		const before = fake.run.mock.calls.length;
		await expect(fake.db.reset()).rejects.toThrow("refusing to take over");
		await expect(fake.db.stop()).rejects.toThrow("refusing to take over");
		expect(fake.run.mock.calls.slice(before).every(([, args]) => args[1] === "inspect")).toBe(true);
	});
	it("bounds readiness and stops only the started DB, retaining data on startup failure", async () => {
		const fake = fakeDatabase(); fake.setReady(false);
		try { await expect(fake.db.start(new AbortController().signal, 0)).rejects.toThrow("readiness timed out"); }
		finally { await fake.db.stopStarted(); }
		expect(fake.container?.State.Running).toBe(false);
		expect(fake.volume).toBeDefined();
	});
	it("recovers this invocation's container receipt after an engine response loss for cleanup", async () => {
		const fake = fakeDatabase(); const normal = fake.run.getMockImplementation()!;
		fake.run.mockImplementation(async (engine, args) => {
			const response = await normal(engine, args);
			return args[0] === "run" ? { code: -1, stdout: "" } : response;
		});
		await expect(fake.db.start(new AbortController().signal)).rejects.toThrow("run failed");
		await fake.db.stopStarted();
		expect(fake.container?.State.Running).toBe(false);
		expect(fake.volume).toBeDefined();
	});
	it("cancels before touching resources and refuses opaque inspect failures", async () => {
		const fake = fakeDatabase(); const controller = new AbortController(); controller.abort();
		await expect(fake.db.start(controller.signal)).rejects.toThrow();
		expect(fake.run).not.toHaveBeenCalled();
		fake.run.mockResolvedValue({ code: 1, stdout: "" });
		await expect(fake.db.stop()).rejects.toThrow("could not inspect");
		fake.run.mockResolvedValue({ code: 0, stdout: "private engine diagnostic" });
		await expect(fake.db.stop()).rejects.toThrow("invalid resource information");
	});
	it("reset removes only verified resources, without forcing volume deletion", async () => {
		const fake = fakeDatabase(); await fake.db.start(new AbortController().signal);
		await fake.db.reset();
		expect(fake.container).toBeUndefined(); expect(fake.volume).toBeUndefined();
		expect(fake.run.mock.calls.map(([, args]) => args).filter((args) => args.includes("rm"))).toEqual([["rm", "owned-id"], ["volume", "rm", config.volume]]);
	});
});
