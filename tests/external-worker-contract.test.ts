import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  externalWorkerConfig,
  requestExternalWorker,
  runExternalWorker,
  WorkerHttpError,
  type ExternalWorkerConfig,
  type ExecuteVercel,
} from "../scripts/external-worker.ts";

const url = "https://worker-fixture.vercel.app";
const token = "worker-fixture-only";
const summary = { discovered: 2, driven: 1, pending: 1, projections: 2 };
const response =
  JSON.stringify({
    discovered: 2,
    driven: [{}],
    pending: [{}],
    projections: [{}, {}],
    privateDiagnostic: "fixture-private-response",
  }) + "\n200";
const config: ExternalWorkerConfig = { url, token };
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "pi-external-worker-"));
});
afterEach(async () => {
  vi.useRealTimers();
  await rm(directory, { recursive: true, force: true });
});

describe("external worker configuration", () => {
  it("uses an explicitly configured target and worker credential", async () => {
    expect(
      await externalWorkerConfig([], { CRON_SECRET: token, EXTERNAL_WORKER_URL: url }),
    ).toEqual(config);
    expect(await externalWorkerConfig(["--url", `${url}/`], { CRON_SECRET: token })).toEqual(
      config,
    );
  });

  it("loads the selected file without substituting exported credentials", async () => {
    const path = join(directory, "worker-config");
    await writeFile(path, `CRON_SECRET="${token}"\nEXTERNAL_WORKER_URL=${url}\n`, { mode: 0o600 });
    expect(
      await externalWorkerConfig(["--env-file", path], { CRON_SECRET: "wrong-exported-token" }),
    ).toEqual(config);
  });

  it("never substitutes the API token for a missing worker credential", async () => {
    const path = join(directory, "api-only-config");
    await writeFile(path, `APP_API_TOKEN=fixture-api-token\nEXTERNAL_WORKER_URL=${url}\n`);
    await expect(
      externalWorkerConfig(["--env-file", path], { CRON_SECRET: token }),
    ).rejects.toThrow("CRON_SECRET");
  });

  it("shows help without reading a credential file", async () => {
    expect(
      await externalWorkerConfig(["--help", "--env-file", join(directory, "missing")], {}),
    ).toBeUndefined();
  });

  it.each([
    "http://worker-fixture.vercel.app",
    `${url}/api/worker`,
    `${url}?token=fixture`,
    `${url}#fragment`,
    "https://user:password@worker-fixture.vercel.app",
    "not-a-url",
  ])("rejects unsafe or ambiguous deployment URLs: %s", async (target) => {
    await expect(externalWorkerConfig(["--url", target], { CRON_SECRET: token })).rejects.toThrow(
      "HTTPS deployment origin",
    );
  });

  it.each(["line\nbreak", "line\rbreak", "two words", "null\0byte"])(
    "rejects invalid header credentials",
    async (value) => {
      await expect(externalWorkerConfig(["--url", url], { CRON_SECRET: value })).rejects.toThrow(
        "CRON_SECRET",
      );
    },
  );

  it("does not echo secret-looking invalid options or filesystem errors", async () => {
    await expect(externalWorkerConfig(["--token=fixture-private-secret"], {})).rejects.toThrow(
      "Invalid arguments. Run pnpm worker:external --help.",
    );
    await expect(
      externalWorkerConfig(["--env-file", join(directory, "fixture-private-secret")], {}),
    ).rejects.toThrow("Cannot load the worker env file.");
  });
});

describe("protected worker transport", () => {
  it("sends only worker authorization through stdin and returns allowlisted counts", async () => {
    const execute = vi.fn<ExecuteVercel>().mockResolvedValue(response);
    expect(await requestExternalWorker(config, execute)).toEqual(summary);
    const [args, stdin] = execute.mock.calls[0]!;
    expect(args.slice(0, args.indexOf("--"))).toEqual(["curl", "/api/worker", "--deployment", url]);
    expect(args).toContain("POST");
    expect(args).toContain("@-");
    expect(args).toContain("65");
    expect(args).not.toContain(token);
    expect(stdin).toBe(`Authorization: Bearer ${token}\n`);
    expect(args).not.toContain("--data");
    expect(args).not.toContain("--protection-bypass");
  });

  it.each([
    [
      `fixture-private-response\n401`,
      "Worker returned HTTP 401. Check CRON_SECRET and Preview access.",
    ],
    [
      `fixture-private-response\n500`,
      "Worker returned HTTP 500. Server-side failure; inspect deployment logs.",
    ],
    [`fixture-private-response`, "Unexpected HTTP response format"],
    [`<html>fixture-private-response</html>\n200`, "Invalid worker response"],
    [`{"discovered":-1,"private":"fixture-private-response"}\n200`, "Invalid worker response"],
    ["null\n200", "Invalid worker response"],
  ])("rejects failed or malformed responses without exposing bodies", async (raw, message) => {
    const error = await requestExternalWorker(config, async () => raw).catch(
      (error: unknown) => error,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error).toHaveProperty("message", expect.stringContaining(message));
    expect(error).toHaveProperty("message", expect.not.stringContaining("fixture-private-response"));
  });

  it("does not expose subprocess diagnostics", async () => {
    const execute: ExecuteVercel = async () => {
      throw new Error("fixture-private-secret");
    };
    await expect(requestExternalWorker(config, execute)).rejects.toThrow(
      "Vercel request failed. Check login, deployment and connectivity.",
    );
  });
});

describe("resident external wake-ups", () => {
  it("keeps running and waits 60 seconds after completion without overlapping requests", async () => {
    vi.useFakeTimers();
    const tick = vi
      .fn()
      .mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 70_000));
        return summary;
      })
      .mockResolvedValueOnce(summary)
      .mockRejectedValue(new Error("fixture stop"));
    const log = vi.fn();
    const run = expect(runExternalWorker(config, tick, log)).rejects.toThrow("fixture stop");
    await vi.advanceTimersByTimeAsync(70_000);
    expect(tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(tick).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    await run;
    expect(tick).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
    expect(log.mock.calls.flat().join("\n")).not.toContain(token);
  });

  it("stops on transport or protocol failures", async () => {
    const tick = vi.fn().mockRejectedValue(new Error("fixture failure"));
    await expect(runExternalWorker(config, tick, () => {})).rejects.toThrow("fixture failure");
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it("keeps scheduled wake-ups after a server error without issuing an immediate retry", async () => {
    vi.useFakeTimers();
    const tick = vi
      .fn()
      .mockRejectedValueOnce(new WorkerHttpError(500))
      .mockResolvedValueOnce(summary)
      .mockRejectedValue(new Error("fixture stop"));
    const log = vi.fn();
    const run = expect(runExternalWorker(config, tick, log)).rejects.toThrow("fixture stop");
    await vi.advanceTimersByTimeAsync(59_999);
    expect(tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(tick).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    await run;
    expect(tick).toHaveBeenCalledTimes(3);
    expect(log.mock.calls.flat().join("\n")).toContain("Next wake-up in 60s.");
  });

  it.each([401, 403, 404])("stops immediately on HTTP %s", async (status) => {
    const tick = vi.fn().mockRejectedValue(new WorkerHttpError(status));
    await expect(runExternalWorker(config, tick, () => {})).rejects.toThrow(`HTTP ${status}`);
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it("runs the real CLI against a fake Vercel executable without leaking credentials", async () => {
    const metadata = join(directory, "metadata.json");
    await symlink(
      fileURLToPath(new URL("./fixtures/external-vercel.ts", import.meta.url)),
      join(directory, "vercel"),
    );
    const script = fileURLToPath(new URL("../scripts/worker-external.ts", import.meta.url));
    const child = spawn(process.execPath, ["--import", "tsx", script], {
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        CRON_SECRET: token,
        EXTERNAL_WORKER_URL: url,
        TEST_EXTERNAL_WORKER_METADATA: metadata,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const exit = await Promise.race([
        exited,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("External worker CLI did not exit within 10s.")), 10_000);
        }),
      ]);
      clearTimeout(timer);
      expect(exit).toBe(1);
      expect(stderr).toContain("Worker returned HTTP 401");
      expect(stdout + stderr).not.toContain(token);
      expect(stdout + stderr).not.toContain("fixture-private-response");
      const recorded = JSON.parse(await readFile(metadata, "utf8"));
      expect(recorded.workerHeaderMatched).toBe(true);
      expect(recorded.args).not.toContain(token);
      expect(recorded.args).toContain("@-");
    } finally {
      clearTimeout(timer);
      child.kill("SIGKILL");
      await exited.catch(() => undefined);
    }
  }, 15_000);
});
