import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deletePiPostgresSession, ensurePiPostgresSchema, PgExecutor } from "../packages/pi-postgres/src/index.ts";

const databaseUrl = process.env.DATABASE_URL;
const workerPath = fileURLToPath(new URL("./fixtures/postgres-tool-recovery-worker.ts", import.meta.url));
const tsxPath = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url));

describe.skipIf(databaseUrl === undefined)("fresh-process tool effect recovery", () => {
	const executor = new PgExecutor({ connectionString: databaseUrl });
	beforeAll(async () => ensurePiPostgresSchema(executor));
	afterAll(async () => executor.close());

	it.each([
		["never", 1],
		["safe", 2],
	] as const)("honors %s replay policy after an unknown effect outcome", async (replay, expectedEffects) => {
		const sessionId = `tool-recovery-${randomUUID()}`;
		const effectFile = `/tmp/${sessionId}.effects`;
		const started = spawnWorker("start", sessionId, replay, effectFile);
		await waitForEffect(effectFile);
		started.kill("SIGKILL");
		await childExit(started);
		await new Promise((resolve) => setTimeout(resolve, 1_200));
		const operationId = await findOperationId(sessionId, replay, effectFile);
		const resumed = spawnWorker("resume", sessionId, replay, effectFile, operationId);
		const output = await childOutput(resumed);
		expect(output.code, output.stderr).toBe(0);
		expect(JSON.parse(output.stdout)).toEqual({ status: "completed" });
		expect(readFileSync(effectFile, "utf8").trim().split("\n")).toHaveLength(expectedEffects);
		await deletePiPostgresSession(executor, sessionId);
		if (existsSync(effectFile)) unlinkSync(effectFile);
		if (existsSync(`${effectFile}.operation`)) unlinkSync(`${effectFile}.operation`);
	}, 30_000);

	async function findOperationId(sessionId: string, replay: string, effectFile: string): Promise<string> {
		// The start worker persists the operation before entering the effect. The
		// operation id is emitted through a sidecar-free query in the worker's
		// durable session; this helper uses the test-only marker file convention.
		const marker = `${effectFile}.operation`;
		for (let attempt = 0; attempt < 50; attempt++) {
			if (existsSync(marker)) return readFileSync(marker, "utf8").trim();
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		throw new Error(`operation marker was not written for ${sessionId}/${replay}`);
	}

	function spawnWorker(mode: "start" | "resume", sessionId: string, replay: string, effectFile: string, operationId?: string) {
		return spawn(process.execPath, [tsxPath, workerPath, mode], {
			env: { ...process.env, DATABASE_URL: databaseUrl, POC_SESSION_ID: sessionId, POC_REPLAY: replay, POC_EFFECT_FILE: effectFile, ...(operationId === undefined ? {} : { POC_OPERATION_ID: operationId }) },
		});
	}
});

function waitForEffect(path: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const startedAt = Date.now();
		const poll = () => {
			if (existsSync(path)) return resolve();
			if (Date.now() - startedAt > 20_000) return reject(new Error(`effect did not start: ${path}`));
			setTimeout(poll, 20);
		};
		poll();
	});
}

function childExit(child: ReturnType<typeof spawn>): Promise<void> {
	return new Promise((resolve) => child.once("close", () => resolve()));
}

function childOutput(child: ReturnType<typeof spawn>): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		let stdout = ""; let stderr = "";
		child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
		child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
		child.on("close", (code) => resolve({ code, stdout: stdout.trim(), stderr }));
	});
}
