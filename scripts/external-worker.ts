import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { parseArgs, parseEnv } from "node:util";
import { FUNCTION_MAX_DURATION_MS } from "../packages/agent-runtime/src/execution-budgets.ts";

const EXTERNAL_WORKER_REQUEST_TIMEOUT_SECONDS = FUNCTION_MAX_DURATION_MS / 1_000 + 10;
const EXTERNAL_WORKER_CLI_TIMEOUT_MS = (EXTERNAL_WORKER_REQUEST_TIMEOUT_SECONDS + 20) * 1_000;

export const EXTERNAL_WORKER_HELP = `Usage: pnpm worker:external [options]

  --url <https-origin>      Deployment URL (or EXTERNAL_WORKER_URL in env)
  --env-file <path>         Read CRON_SECRET from this file (default: .env)
  --help                   Show this help

Requires a logged-in Vercel CLI. Calls only /api/worker through vercel curl.
Uses CRON_SECRET, never APP_API_TOKEN. Waits 60s after each request.
Runs until Ctrl+C. HTTP 5xx waits for the next scheduled request; other failures exit.
Idle requests keep Neon awake.`;

export class ExternalWorkerError extends Error {}
export class WorkerHttpError extends ExternalWorkerError {
  constructor(readonly status: number) {
    const advice =
      status >= 500
        ? "Server-side failure; inspect deployment logs."
        : status === 401 || status === 403
          ? "Check CRON_SECRET and Preview access."
          : "Check deployment routing and access.";
    super(`Worker returned HTTP ${status}. ${advice}`);
  }
}
export type ExternalWorkerConfig = {
  url: string;
  token: string;
};
export type WorkerSummary = {
  discovered: number;
  driven: number;
  pending: number;
  projections: number;
};
export type ExecuteVercel = (args: string[], stdin: string) => Promise<string>;

export async function externalWorkerConfig(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<ExternalWorkerConfig | undefined> {
  let flags;
  try {
    flags = parseArgs({
      args,
      options: {
        url: { type: "string" },
        "env-file": { type: "string" },
        help: { type: "boolean" },
      },
    }).values;
  } catch {
    throw new ExternalWorkerError("Invalid arguments. Run pnpm worker:external --help.");
  }
  if (flags.help) return undefined;
  const explicitFile = flags["env-file"];
  let file: NodeJS.ProcessEnv = {};
  if (explicitFile !== undefined || !env.CRON_SECRET || !(flags.url || env.EXTERNAL_WORKER_URL)) {
    try {
      file = parseEnv(await readFile(explicitFile ?? ".env", "utf8"));
    } catch (error) {
      if (explicitFile !== undefined || (error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new ExternalWorkerError("Cannot load the worker env file.");
      }
    }
  }
  const token =
    explicitFile === undefined ? (env.CRON_SECRET ?? file.CRON_SECRET) : file.CRON_SECRET;
  if (!token || /[\x00-\x20\x7f]/.test(token))
    throw new ExternalWorkerError("A nonempty CRON_SECRET without whitespace is required.");
  let url: URL;
  try {
    url = new URL(flags.url ?? env.EXTERNAL_WORKER_URL ?? file.EXTERNAL_WORKER_URL ?? "");
  } catch {
    throw new ExternalWorkerError(
      "An HTTPS deployment origin is required. Use --url or EXTERNAL_WORKER_URL.",
    );
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new ExternalWorkerError(
      "Use an HTTPS deployment origin without credentials, path, query or fragment.",
    );
  }
  return { url: url.origin, token };
}

// Keep credentials in stdin and response bodies out of diagnostics.
export const executeVercel: ExecuteVercel = (args, stdin) =>
  new Promise((resolve, reject) => {
    const child = spawn("vercel", args, {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: EXTERNAL_WORKER_CLI_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    let stdout = "";
    let bytes = 0;
    let overflow = false;
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 1_048_576) {
        overflow = true;
        child.kill("SIGKILL");
      } else stdout += chunk.toString();
    });
    child.stderr.resume();
    child.stdin.on("error", () => {});
    child.once("error", () =>
      reject(new ExternalWorkerError("Vercel CLI could not start. Check installation and login.")),
    );
    child.once("close", (code) => {
      if (code !== 0 || overflow)
        reject(
          new ExternalWorkerError(
            "Vercel request failed. Check login, deployment and connectivity.",
          ),
        );
      else resolve(stdout);
    });
    child.stdin.end(stdin);
  });

export async function requestExternalWorker(
  config: ExternalWorkerConfig,
  execute: ExecuteVercel = executeVercel,
): Promise<WorkerSummary> {
  let response: string;
  try {
    response = await execute(
      [
        "curl",
        "/api/worker",
        "--deployment",
        config.url,
        "--",
        "--request",
        "POST",
        "--header",
        "@-",
        "--silent",
        "--show-error",
        "--max-time",
        String(EXTERNAL_WORKER_REQUEST_TIMEOUT_SECONDS),
        "--max-redirs",
        "0",
        "--write-out",
        "\n%{http_code}",
      ],
      `Authorization: Bearer ${config.token}\n`,
    );
  } catch {
    throw new ExternalWorkerError(
      "Vercel request failed. Check login, deployment and connectivity.",
    );
  }
  const split = response.lastIndexOf("\n");
  const status = response.slice(split + 1).trim();
  if (!/^\d{3}$/.test(status) || Number(status) < 100 || Number(status) > 599)
    throw new ExternalWorkerError("Unexpected HTTP response format.");
  if (status !== "200") throw new WorkerHttpError(Number(status));
  let body;
  try {
    body = JSON.parse(response.slice(0, split));
  } catch {
    throw new ExternalWorkerError("Invalid worker response. Check deployment routing and access.");
  }
  if (
    !body ||
    !Number.isSafeInteger(body.discovered) ||
    body.discovered < 0 ||
    !Array.isArray(body.driven) ||
    !Array.isArray(body.pending) ||
    !Array.isArray(body.projections)
  ) {
    throw new ExternalWorkerError("Invalid worker response. Check deployment routing and access.");
  }
  return {
    discovered: body.discovered,
    driven: body.driven.length,
    pending: body.pending.length,
    projections: body.projections.length,
  };
}

export async function runExternalWorker(
  config: ExternalWorkerConfig,
  tick: (config: ExternalWorkerConfig) => Promise<WorkerSummary> = requestExternalWorker,
  log: (message: string) => void = console.log,
): Promise<void> {
  while (true) {
    log("Worker request started.");
    try {
      const result = await tick(config);
      log(
        `HTTP 200 · discovered ${result.discovered} · driven ${result.driven} · pending ${result.pending} · projections ${result.projections}`,
      );
    } catch (error) {
      if (!(error instanceof WorkerHttpError) || error.status < 500) throw error;
      log(`${error.message} Next wake-up in 60s.`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 60_000));
  }
}
