import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deletePiPostgresSession, ensurePiPostgresSchema, PgExecutor } from "../packages/pi-postgres/src/index.ts";

const databaseUrl = process.env.DATABASE_URL;
const workerPath = fileURLToPath(new URL("./fixtures/postgres-resume-worker.ts", import.meta.url));

describe.skipIf(databaseUrl === undefined)("fresh-process Agent recovery", () => {
	const executor = new PgExecutor({ connectionString: databaseUrl });

	beforeAll(async () => {
		await ensurePiPostgresSchema(executor);
	});
	afterAll(async () => {
		await executor.close();
	});

	it("resumes an accepted operation with a fresh repository and harness", async () => {
		const sessionId = `runtime-${randomUUID()}`;
		const started = await runWorker("start", sessionId);
		expect(started.code).toBe(0);
		const admission = JSON.parse(started.stdout) as { operationId: string };
		const resumed = await runWorker("resume", sessionId, admission.operationId);
		expect(resumed.code, resumed.stderr).toBe(0);
		expect(JSON.parse(resumed.stdout)).toEqual({ status: "completed", entries: ["message", "message"] });
		await deletePiPostgresSession(executor, sessionId);
	});

	function runWorker(workerMode: "start" | "resume", sessionId: string, operationId?: string): Promise<WorkerResult> {
		return new Promise((resolve) => {
			const child = spawn(process.execPath, ["--experimental-strip-types", workerPath, workerMode], {
				env: {
					...process.env,
					DATABASE_URL: databaseUrl,
					POC_SESSION_ID: sessionId,
					...(operationId === undefined ? {} : { POC_OPERATION_ID: operationId }),
				},
			});
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (chunk: Buffer) => {
				stdout += chunk.toString();
			});
			child.stderr.on("data", (chunk: Buffer) => {
				stderr += chunk.toString();
			});
			child.on("close", (code, signal) => resolve({ code, signal, stdout: stdout.trim(), stderr }));
		});
	}
});

interface WorkerResult {
	readonly code: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly stdout: string;
	readonly stderr: string;
}
