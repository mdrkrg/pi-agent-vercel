import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core/harness/context";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deletePiPostgresSession, DriveJobRepo, ensurePiPostgresSchema, PgExecutor, PostgresSessionRepo, PostgresStorage, SubmissionRepo } from "../packages/pi-postgres/src/index.ts";

const databaseUrl = process.env.DATABASE_URL;
const fixture = fileURLToPath(new URL("./fixtures/postgres-function-crash-worker.ts", import.meta.url));
const principal = { userId: "crash-user", tenantId: "crash-tenant" };
type Worker = { child: ChildProcess; ready: Promise<void>; exited: Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }> };
function worker(mode: "start" | "resume", phase: string, effectFile: string, sessionId?: string, replay?: string): Worker {
	const child = spawn(process.execPath, ["--import", "tsx", fixture, mode], { env: { ...process.env, DATABASE_URL: databaseUrl, TEST_EFFECT_FILE: effectFile, TEST_CRASH_PHASE: phase, TEST_SESSION_ID: sessionId, TEST_REPLAY: replay }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
	let stderr = ""; child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); }); child.stdout!.resume();
	const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>((resolve) => child.once("close", (code, signal) => resolve({ code, signal, stderr })));
	const ready = new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Crash worker did not reach boundary: " + stderr)); }, 15_000);
		child.once("message", () => { clearTimeout(timer); resolve(); });
		child.once("error", (error) => { clearTimeout(timer); reject(error); });
		child.once("close", () => { clearTimeout(timer); if (mode === "start") reject(new Error("Crash worker exited before boundary: " + stderr)); else resolve(); });
	});
	return { child, ready, exited };
}
async function lines(path: string): Promise<string[]> {
	try { return (await readFile(path, "utf8")).trim().split("\n").filter(Boolean); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

describe.skipIf(databaseUrl === undefined)("fresh Function crash matrix without client retry", () => {
	const executor = new PgExecutor({ connectionString: databaseUrl }); const repo = new PostgresSessionRepo(executor);
	const submissions = new SubmissionRepo(executor); const jobs = new DriveJobRepo(executor);
	beforeAll(async () => ensurePiPostgresSchema(executor));
	afterAll(async () => { await repo.close(BACKGROUND_CONTEXT); await executor.close(); });

	for (const phase of ["before-accept", "after-accept", "after-publish", "after-terminal", "provider", "deferred", "tool-safe", "tool-never"]) {
		it(`recovers SIGKILL at ${phase} using only a database worker tick`, async () => {
			const session = await repo.createWithOwner(principal, BACKGROUND_CONTEXT); const sessionId = session.metadata.id; await session.close(BACKGROUND_CONTEXT);
			const directory = await mkdtemp(join(tmpdir(), "pi-function-crash-")); const effectFile = join(directory, "effect");
			const crashPhase = phase.startsWith("tool-") ? "tool" : phase;
			const started = worker("start", crashPhase, effectFile, sessionId, phase === "tool-safe" ? "safe" : "never");
			let resumed: Worker | undefined;
			try {
				await started.ready;
				const identities = await executor.query<{ id: string }>("SELECT id FROM agent_submissions WHERE session_id=$1", [sessionId]);
				const submission = (await submissions.get(identities.rows[0]!.id))!;
				expect(submission).toBeDefined();
				const before = await repo.readOperation(sessionId, submission.id);
				if (phase === "before-accept") expect(before).toEqual({});
				if (phase === "after-accept") { expect(before.meta?.operationId).toBe(submission.id); expect(submission.operationId).toBeNull(); }
				if (phase === "after-publish") expect(submission.operationId).toBe(submission.id);
				if (phase === "after-terminal") { expect(before.result?.status).toBe("completed"); expect(submission.status).toBe("running"); }
				if (phase === "provider") expect(before.state?.at).toBe("assistant.effect_pending");
				if (phase === "deferred") {
					expect(before.state?.at).toBe("deferred.suspended");
					expect(await jobs.listRecoverable(sessionId)).toEqual([expect.objectContaining({ status: "waiting", claimOwner: null, deferredHandle: expect.objectContaining({ id: "durable-provider-handle", pollAfterMs: 500 }) })]);
				}
				if (phase.startsWith("tool-")) expect(before.state?.at).toBe("tools");
				started.child.kill("SIGKILL"); expect((await started.exited).signal).toBe("SIGKILL");
				// Real TTL expiry: no manual release or privileged projection repair.
				await new Promise((resolve) => setTimeout(resolve, 750));
				resumed = worker("resume", crashPhase, effectFile, undefined, phase === "tool-safe" ? "safe" : "never");
				const finished = await resumed.exited; expect(finished.code, finished.stderr).toBe(0);
				if (phase === "provider") {
					const interrupted = await repo.readOperation(sessionId, submission.id);
					expect(interrupted.state?.at).toBe("assistant.retry_wait");
					expect(await submissions.get(submission.id)).toMatchObject({ status: "waiting", resultRef: null });
					expect(await lines(`${effectFile}.provider`)).toEqual(["start"]);
					if (interrupted.state?.at !== "assistant.retry_wait") throw new Error("Expected durable Pi retry wait");
					const [waiting] = await jobs.listRecoverable(sessionId);
					expect(waiting).toMatchObject({ status: "waiting", availableAt: interrupted.state.notBefore, claimOwner: null });
					const delay = Math.max(0, interrupted.state.notBefore - Date.now()) + 25;
					await new Promise((resolve) => setTimeout(resolve, delay));
					resumed = worker("resume", crashPhase, effectFile);
					const retried = await resumed.exited; expect(retried.code, retried.stderr).toBe(0);
				}
				const after = await repo.readOperation(sessionId, submission.id);
				expect(after.meta).toBeUndefined(); expect(after.state).toBeUndefined();
				expect(after.result?.status).toBe("completed");
				expect(await submissions.get(submission.id)).toMatchObject({ operationId: submission.id, status: "completed", resultRef: `pi.result:${submission.id}` });
				const jobRows = await executor.query<{ id: string }>("SELECT id FROM agent_drive_jobs WHERE session_id=$1", [sessionId]);
				expect(jobRows.rows).toHaveLength(1);
				expect(await jobs.get(jobRows.rows[0]!.id)).toMatchObject({ operationId: submission.id, submissionId: submission.id, status: "completed" });
				const storage = new PostgresStorage(executor, sessionId);
				try {
					const entries = await storage.scanEntries({ order: "asc" }, BACKGROUND_CONTEXT);
					expect(entries.filter((entry) => entry.type === "message" && entry.message.role === "user")).toHaveLength(1);
					if (phase === "provider" && before.state?.at === "assistant.effect_pending") {
						const intent = before.state;
						expect(await lines(`${effectFile}.provider`)).toEqual(["start", "resume"]);
						expect(entries.find((entry) => entry.id === intent.responseEntryId)).toMatchObject({ message: { role: "assistant", stopReason: "error" } });
						const usage = await storage.scanUsage({}, BACKGROUND_CONTEXT);
						expect(usage).toHaveLength(2); expect(usage[0]).toMatchObject({ id: before.state.usageId, entryId: before.state.responseEntryId, usage: { totalTokens: 0 } });
					}
					if (phase.startsWith("tool-")) {
						const effects = (await lines(effectFile)).map((line) => JSON.parse(line));
						expect(effects).toHaveLength(phase === "tool-safe" ? 2 : 1);
						expect(effects[0]).toMatchObject({ principal: { ...principal, scopes: ["agent:run"] }, operationId: submission.id, sessionId });
						if (phase === "tool-safe") { expect(effects[1].invocationId).toBe(effects[0].invocationId); expect(effects[1].principal).toEqual(effects[0].principal); }
						if (phase === "tool-never") expect(entries).toContainEqual(expect.objectContaining({ message: expect.objectContaining({ role: "toolResult", isError: true }) }));
					}
					if (phase === "deferred") {
						expect(await lines(`${effectFile}.provider`)).toEqual(["start"]);
						expect((await lines(`${effectFile}.deferred`)).map((line) => JSON.parse(line))).toEqual([{ mode: "start", id: "durable-provider-handle" }, { mode: "resume", id: "durable-provider-handle" }]);
						expect(entries.find((entry) => entry.id === after.result?.tipId)).toMatchObject({ message: { content: [{ type: "text", text: "deferred answer" }] } });
					}
				} finally { await storage.close(BACKGROUND_CONTEXT); }
			} finally {
				started.child.kill("SIGKILL"); if (resumed !== undefined) resumed.child.kill("SIGKILL");
				await started.exited; if (resumed !== undefined) await resumed.exited;
				await deletePiPostgresSession(executor, sessionId); await rm(directory, { recursive: true, force: true });
			}
		}, 30_000);
	}
});
