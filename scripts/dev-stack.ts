import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rmdir } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const DEV_IMAGE = "docker.io/library/postgres:16";
// Public, fixed local FAUX credential; never print inherited application credentials.
export const DEV_API_TOKEN = "local-api";
const OWNER_LABEL = "io.pi-agent-vercel.dev.owner";
const SCOPE_LABEL = "io.pi-agent-vercel.dev.scope";
const RUN_LABEL = "io.pi-agent-vercel.dev.run";
export type Engine = "podman" | "docker";
export type CommandResult = { code: number; stdout: string };
export type Execute = (engine: Engine, args: string[]) => Promise<CommandResult>;
export type DevConfig = {
	root: string; namespace: string; container: string; volume: string; lock: string;
	dbPort: number; servicePort: number; uiPort: number; response: string;
};

function port(value: string | undefined, fallback: number): number {
	const result = value === undefined ? fallback : Number(value);
	if (!Number.isInteger(result) || result < 1024 || result > 65535) throw new Error("Development ports must be between 1024 and 65535.");
	return result;
}
export function devConfig(root: string, env: NodeJS.ProcessEnv): DevConfig {
	const namespace = env.DEV_STACK_NAME ?? "pi-agent-vercel-faux";
	if (!/^[a-z][a-z0-9-]{0,40}$/.test(namespace)) throw new Error("DEV_STACK_NAME must start with a lowercase letter and contain only lowercase letters, digits and hyphens (up to 41 characters).");
	const config = {
		root: resolve(root), namespace, container: `${namespace}-db`, volume: `${namespace}-pgdata`,
		lock: join(resolve(root), "node_modules", ".cache", `${namespace}.lock`),
		dbPort: port(env.DEV_DB_PORT, 55432), servicePort: port(env.DEV_SERVICE_PORT, 3080), uiPort: port(env.DEV_UI_PORT, 5173),
		response: env.DEV_FAUX_RESPONSE ?? "This is a fixed FAUX response.",
	};
	if (new Set([config.dbPort, config.servicePort, config.uiPort]).size !== 3) throw new Error("Database, backend and UI ports must be distinct.");
	return config;
}

export function fauxEnvironment(config: DevConfig, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	return {
		...env,
		DATABASE_URL: `postgresql://postgres:local-faux-only@127.0.0.1:${config.dbPort}/pi_chat_faux`,
		PGSSLMODE: "disable",
		APP_API_TOKEN: DEV_API_TOKEN, CRON_SECRET: "local-worker", APP_USER_ID: "local-user", APP_TENANT_ID: "local-tenant",
		AGENT_FAUX_RESPONSE: config.response, PORT: String(config.servicePort), DEV_SERVICE_PORT: String(config.servicePort),
		AGENT_POLL_MS: "1000", AGENT_ADMISSION_MS: "10000", AGENT_PASS_MS: "45000", AGENT_INVOCATION_MS: "55000",
	};
}

// Capture diagnostics internally; never echo engine arguments, env, or database logs.
export const execute: Execute = (engine, args) => new Promise((done) => {
	execFile(engine, args, { timeout: 120_000, maxBuffer: 1_048_576 }, (error, stdout) => {
		done({ code: error === null ? 0 : typeof error.code === "number" ? error.code : -1, stdout });
	});
});

export async function chooseEngine(env: NodeJS.ProcessEnv, run: Execute = execute): Promise<Engine> {
	if (env.DEV_CONTAINER_ENGINE !== undefined && !["podman", "docker"].includes(env.DEV_CONTAINER_ENGINE)) throw new Error("DEV_CONTAINER_ENGINE must be podman or docker.");
	if ((env.CONTAINER_HOST && !env.CONTAINER_HOST.startsWith("unix://")) || env.CONTAINER_CONNECTION
		|| (env.DOCKER_HOST && !/^(unix|npipe):/.test(env.DOCKER_HOST))) throw new Error("Development scripts require a local container engine; remote services are not allowed.");
	const candidates: Engine[] = env.DEV_CONTAINER_ENGINE ? [env.DEV_CONTAINER_ENGINE as Engine] : ["podman", "docker"];
	for (const engine of candidates) {
		if (engine === "docker" && !env.DOCKER_HOST) {
			const context = await run(engine, ["context", "inspect", "--format", '{{(index .Endpoints "docker").Host}}']);
			if (context.code !== 0) continue;
			if (!/^(unix|npipe):/.test(context.stdout.trim())) throw new Error("Docker context must use a local socket; switch to a local context.");
		}
		if ((await run(engine, ["ps", "--format", "{{.ID}}"])).code !== 0) continue;
		return engine;
	}
	throw new Error("No local Podman/Docker engine is available; install and start a container engine.");
}

export async function acquireDevLock(config: DevConfig): Promise<() => Promise<void>> {
	await mkdir(join(config.root, "node_modules", ".cache"), { recursive: true });
	try { await mkdir(config.lock); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		throw new Error(`Development stack is locked. Press Ctrl+C in its dev:faux terminal first. After a hard termination, confirm its processes are gone before removing this empty lock directory: ${config.lock}`);
	}
	return async () => { await rmdir(config.lock); };
}

export async function checkPorts(config: DevConfig): Promise<void> {
	for (const [name, value] of [["Database", config.dbPort], ["Backend", config.servicePort], ["UI", config.uiPort]] as const) {
		await new Promise<void>((done, reject) => {
			const server = createServer();
			server.once("error", () => reject(new Error(`${name} port ${value} is occupied or cannot be bound. Existing processes will not be stopped; set the corresponding DEV_*_PORT.`)));
			server.listen(value, "127.0.0.1", () => server.close((error) => error ? reject(error) : done()));
		});
	}
}

type Container = {
	Id: string; Config: { Labels?: Record<string, string>; Image: string };
	State: { Running: boolean }; Mounts: { Type: string; Name?: string; Destination: string }[];
	HostConfig: { PortBindings: Record<string, { HostIp: string; HostPort: string }[]> };
};
type Volume = { Labels?: Record<string, string> };

export class DevDatabase {
	private startedId: string | undefined;
	private readonly runId = randomUUID();
	constructor(readonly config: DevConfig, readonly engine: Engine, private readonly run: Execute = execute) {}
	private async command(args: string[]): Promise<string> {
		const result = await this.run(this.engine, args);
		if (result.code !== 0) throw new Error(`${this.engine} ${args[0]} failed (exit ${result.code}); check the local container engine.`);
		return result.stdout.trim();
	}
	private async inspect<T>(kind: "container" | "volume", id: string): Promise<T | undefined> {
		const result = await this.run(this.engine, [kind, "inspect", id]);
		if ([1, 125].includes(result.code) && result.stdout.trim() === "[]") return undefined;
		if (result.code !== 0) throw new Error(`${this.engine} could not inspect the development ${kind}; no resources were modified by this check.`);
		let values: unknown;
		try { values = JSON.parse(result.stdout); }
		catch { throw new Error("The container engine returned invalid resource information."); }
		if (!Array.isArray(values) || values.length !== 1) throw new Error("The container engine returned invalid resource information.");
		return values[0] as T;
	}
	private owner(labels?: Record<string, string>): void {
		if (labels?.[OWNER_LABEL] !== this.config.root || labels?.[SCOPE_LABEL] !== this.config.namespace) {
			throw new Error("The same-name container or volume is not owned by this checkout's development stack; refusing to take over, stop or delete it.");
		}
	}
	private labels(): string[] {
		return ["--label", `${OWNER_LABEL}=${this.config.root}`, "--label", `${SCOPE_LABEL}=${this.config.namespace}`];
	}
	private async resources(): Promise<{ container: Container | undefined; volume: Volume | undefined }> {
		const container = await this.inspect<Container>("container", this.config.container);
		const volume = await this.inspect<Volume>("volume", this.config.volume);
		if (container) this.owner(container.Config.Labels);
		if (volume) this.owner(volume.Labels);
		if (container && (!volume || !container.Mounts.some((mount) => mount.Type === "volume" && mount.Name === this.config.volume && mount.Destination === "/var/lib/postgresql/data"))) {
			throw new Error("The development container does not mount the expected owned volume; refusing to modify resources.");
		}
		return { container, volume };
	}
	async start(signal: AbortSignal, readyTimeoutMs = 30_000): Promise<void> {
		signal.throwIfAborted();
		const { container, volume } = await this.resources();
		if (container?.State.Running) throw new Error("The development database is already running. Exit the old dev:faux runner or use dev:stop; refusing to take over an active container.");
		if (container) {
			const bindings = container.HostConfig.PortBindings["5432/tcp"];
			if (container.Config.Image !== DEV_IMAGE || bindings?.length !== 1 || bindings[0]?.HostIp !== "127.0.0.1" || bindings[0].HostPort !== String(this.config.dbPort)) {
				throw new Error("The existing development container's image or port differs from the configuration; use its original settings or explicitly dev:reset before rebuilding.");
			}
		}
		await checkPorts(this.config);
		signal.throwIfAborted();
		if (!volume) {
			await this.command(["volume", "create", ...this.labels(), this.config.volume]);
			const created = await this.inspect<Volume>("volume", this.config.volume);
			if (!created) throw new Error("The new development volume is not visible; the database was not started.");
			this.owner(created.Labels);
		}
		signal.throwIfAborted();
		if (container) {
			this.startedId = container.Id;
			await this.command(["start", container.Id]);
		} else {
			try {
				this.startedId = await this.command([
					"run", "--detach", "--name", this.config.container, ...this.labels(), "--label", `${RUN_LABEL}=${this.runId}`,
					...(this.engine === "podman" ? ["--cgroupns=host"] : []),
					"--publish", `127.0.0.1:${this.config.dbPort}:5432`,
					"--mount", `type=volume,source=${this.config.volume},target=/var/lib/postgresql/data`,
					"--env", "POSTGRES_PASSWORD=local-faux-only", "--env", "POSTGRES_DB=pi_chat_faux", DEV_IMAGE,
				]);
			} catch (error) {
				// A lost engine response may still have created a container. Recover only THIS run's receipt.
				const created = await this.inspect<Container>("container", this.config.container);
				if (created?.Config.Labels?.[RUN_LABEL] === this.runId) {
					this.owner(created.Config.Labels); this.startedId = created.Id;
				}
				throw error;
			}
		}
		const deadline = Date.now() + readyTimeoutMs;
		while (Date.now() < deadline) {
			signal.throwIfAborted();
			if ((await this.run(this.engine, ["exec", this.startedId!, "pg_isready", "-U", "postgres", "-d", "pi_chat_faux"])).code === 0) {
				signal.throwIfAborted(); return;
			}
			await delay(500, undefined, { signal });
		}
		throw new Error("PostgreSQL readiness timed out; development data is retained and the backend/UI will not start.");
	}
	async stopStarted(): Promise<void> {
		if (!this.startedId) return;
		const container = await this.inspect<Container>("container", this.startedId);
		if (container) {
			this.owner(container.Config.Labels);
			if (container.State.Running) await this.command(["stop", "--time", "10", container.Id]);
		}
		this.startedId = undefined;
	}
	async stop(): Promise<void> {
		const { container } = await this.resources();
		if (container?.State.Running) await this.command(["stop", "--time", "10", container.Id]);
	}
	async reset(): Promise<void> {
		// Inspect ALL ownership before any destructive action; never force-remove volumes.
		const { container, volume } = await this.resources();
		if (container?.State.Running) await this.command(["stop", "--time", "10", container.Id]);
		if (container) await this.command(["rm", container.Id]);
		if (volume) await this.command(["volume", "rm", this.config.volume]);
	}
}
