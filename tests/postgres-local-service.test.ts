import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { deletePiPostgresSession, PgExecutor, SubmissionRepo } from "../packages/pi-postgres/src/index.ts";

const databaseUrl = process.env.DATABASE_URL;
describe.skipIf(databaseUrl === undefined)("independent local Function wake source", () => {
	it("finishes after the HTTP client disconnects without another ingress or worker request", async () => {
		const path = fileURLToPath(new URL("../scripts/local-service.ts", import.meta.url));
		const child = spawn(process.execPath, ["--import", "tsx", path], { env: { ...process.env, DATABASE_URL: databaseUrl, PORT: "0", AGENT_POLL_MS: "100", APP_API_TOKEN: "local-api", CRON_SECRET: "local-cron", APP_USER_ID: "local-user", APP_TENANT_ID: "local-tenant", AGENT_FAUX_RESPONSE: "independent final" }, stdio: ["ignore", "pipe", "pipe"] });
		let stderr = ""; child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
		const exited = new Promise<number | null>((resolve) => child.once("close", resolve));
		const executor = new PgExecutor({ connectionString: databaseUrl }); let sessionId: string | undefined;
		try {
			const baseUrl = await new Promise<string>((resolve, reject) => {
				let stdout = "";
				const timer = setTimeout(() => reject(new Error("Local service did not start: " + stderr)), 10_000);
				child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); const match = /http:\/\/127\.0\.0\.1:\d+/.exec(stdout); if (match !== null) { clearTimeout(timer); resolve(match[0]); } });
				child.once("error", (error) => { clearTimeout(timer); reject(error); });
				child.once("close", () => { clearTimeout(timer); reject(new Error("Local service exited: " + stderr)); });
			});
			const headers = { authorization: "Bearer local-api", connection: "close", "content-type": "application/json" };
			const created = await fetch(`${baseUrl}/api/sessions`, { method: "POST", headers }); expect(created.status).toBe(201);
			const session = await created.json() as { session: { id: string } }; sessionId = session.session.id;
			const accepted = await fetch(`${baseUrl}/api/sessions/${sessionId}/messages`, { method: "POST", headers: { ...headers, "idempotency-key": "disconnected" }, body: JSON.stringify({ prompt: "continue independently" }) }); expect(accepted.status).toBe(202);
			const submission = await accepted.json() as { submission: { id: string } };
			const submissions = new SubmissionRepo(executor);
			// Observe only the database: no HTTP request can wake or drive the operation.
			await vi.waitFor(async () => expect(await submissions.get(submission.submission.id)).toMatchObject({ status: "completed" }), { timeout: 10_000, interval: 100 });
			const result = await fetch(`${baseUrl}/api/submissions/${submission.submission.id}/result`, { headers }); expect(result.status).toBe(200);
			expect(await result.json()).toMatchObject({ result: { status: "completed" }, output: { message: { content: [{ type: "text", text: "independent final" }] } } });
		} finally {
			child.kill("SIGTERM"); const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
			try { expect(await exited, stderr).toBe(0); } finally { clearTimeout(timer); if (sessionId !== undefined) await deletePiPostgresSession(executor, sessionId); await executor.close(); }
		}
	}, 25_000);
});
