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
		expect(config.fluid).toBe(true);
		expect(config.functions["api/index.ts"].maxDuration).toBe(300);
		expect(config.installCommand).toBe("npx --yes pnpm@12.8.1 install --frozen-lockfile");
		expect(config.buildCommand).toBe("npx --yes pnpm@12.8.1 run build");
		expect(config.outputDirectory).toBe("dist");
		expect(config.framework).toBeNull();
		expect(config.rewrites).toEqual([{ source: "/api/:path*", destination: "/api" }]);
		expect(config.functions["api/index.ts"].supportsCancellation).toBe(false);
	});

	it("keeps independent native cron scheduling when the static chat build is enabled", async () => {
		vi.stubEnv("AGENT_WORKER_SCHEDULER", "vercel-cron");
		// @ts-expect-error JavaScript deployment configuration has no declaration file.
		const { default: config } = await import("../vercel.mjs");
		expect(config.crons).toEqual([{ path: "/api/worker", schedule: "* * * * *" }]);
		expect(config.outputDirectory).toBe("dist");
	});

	it("includes frontend validation and tests in root verification commands", () => {
		expect(manifest.scripts.check).toContain("tsc --noEmit");
		expect(manifest.scripts.check).toContain("pnpm --filter @pi-agent/chat check");
		expect(manifest.scripts.test).toContain("vitest run --config vitest.config.ts");
		expect(manifest.scripts.test).toContain("pnpm --filter @pi-agent/chat test");
		expect(manifest.scripts.build).toBe("pnpm check && pnpm --filter @pi-agent/chat build");
	});
});
