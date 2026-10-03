import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const workflow = readFileSync(new URL("../.github/workflows/contracts.yml", import.meta.url), "utf8");

describe("Vercel deployment configuration", () => {
	afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

	it("requires Node 24 for local development, CI, and Vercel", () => {
		expect(manifest.engines.node).toBe("24.x");
		expect(manifest.devEngines.runtime).toEqual({ name: "node", version: manifest.engines.node, onFail: "error" });
		expect(workflow).toMatch(/^\s+node-version: 24$/m);
	});

	it("defaults to external scheduling without native cron", async () => {
		vi.stubEnv("AGENT_WORKER_SCHEDULER", undefined);
		// @ts-expect-error JavaScript deployment configuration has no declaration file.
		const { default: config } = await import("../vercel.mjs");
		expect(config.crons).toBeUndefined();
		expect(config.functions["api/index.ts"].maxDuration).toBe(60);
		expect(config.installCommand).toBe("npx --yes pnpm@12.8.1 install --frozen-lockfile");
	});
});
