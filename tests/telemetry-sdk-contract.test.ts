import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const exec = promisify(execFile);
function environment(extra: Record<string, string>) {
	return { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("OTEL_") && !key.startsWith("VERCEL"))), ...extra };
}
type ExportedSpan = { name: string; traceId: string; parentSpanId?: string; attributes: { key: string; value: unknown }[]; events: unknown[]; status: { code: number; message?: string } };
function spans(reports: any[]): ExportedSpan[] {
	return reports.flatMap((report) => report.resourceSpans.flatMap((resource: any) => resource.scopeSpans.flatMap((scope: any) => scope.spans)));
}

it("uses the real Vercel SDK without exporting SDK-enriched headers or losing the platform parent", async () => {
	const result = await exec(process.execPath, ["--import", "tsx", "tests/fixtures/telemetry-process.ts", "host"], { env: environment({ VERCEL: "1" }), timeout: 15_000 });
	expect(result.stderr).toBe("");
	expect(result.stdout).not.toContain("private-");
	const exported = spans(JSON.parse(result.stdout));
	const request = exported.find((span) => span.name === "function.request")!;
	expect(request.traceId).toBe("0123456789abcdef0123456789abcdef");
	expect(request.parentSpanId).toBe("0123456789abcdef");
	expect(request.attributes.map((attribute) => attribute.key).sort()).toEqual(["http.request.method", "http.response.status_code", "http.route"]);
	const handle = exported.find((span) => span.name === "function.handle")!;
	expect(handle.events).toEqual([]);
	expect(handle.status).toEqual({ code: 2 });
}, 20_000);

async function collect(script: string, extra: Record<string, string> = {}) {
	const reports: unknown[] = [];
	const server = createServer(async (req, res) => {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(Buffer.from(chunk));
		reports.push(JSON.parse(Buffer.concat(chunks).toString()));
		res.end("{}");
	});
	await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
	const port = (server.address() as { port: number }).port;
	try {
		await exec(process.execPath, ["--import", "tsx", script], {
			env: environment({ OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}`, OTEL_EXPORTER_OTLP_PROTOCOL: "http/json", OTEL_BSP_SCHEDULE_DELAY: "60000", ...extra }), timeout: 15_000,
		});
		return spans(reports);
	} finally { await new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); }); }
}

it("flushes a short-lived CLI batch to a local collector before exit", async () => {
	expect((await collect("tests/fixtures/telemetry-process.ts")).map((span) => span.name)).toContain("worker.tick");
}, 20_000);

it.skipIf(process.env.DATABASE_URL === undefined)("worker:once flushes its real tick after database cleanup", async () => {
	const exported = await collect("scripts/function-worker.ts", {
		DATABASE_URL: process.env.DATABASE_URL!, APP_API_TOKEN: "private-api", CRON_SECRET: "private-worker",
		APP_USER_ID: "private-user", APP_TENANT_ID: "private-tenant", AGENT_FAUX_RESPONSE: "private-answer",
	});
	expect(exported.map((span) => span.name)).toEqual(expect.arrayContaining(["database.ready", "worker.tick"]));
	expect(exported.find((span) => span.name === "worker.tick")!.attributes).toContainEqual({ key: "agent.worker.phase", value: { stringValue: "complete" } });
	expect(JSON.stringify(exported)).not.toContain("private-");
}, 20_000);
