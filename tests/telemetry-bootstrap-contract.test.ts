import { registerOTel } from "@vercel/otel";
import { trace, type TracerProvider } from "@opentelemetry/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@vercel/otel", () => ({ registerOTel: vi.fn() }));

describe("explicit Node telemetry bootstrap (no exports)", () => {
	beforeEach(() => {
		vi.resetModules(); vi.clearAllMocks();
		for (const key of ["VERCEL", "OTEL_SDK_DISABLED", "OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"]) vi.stubEnv(key, undefined);
	});
	afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.useRealTimers(); });
	const load = () => import("../packages/agent-runtime/src/telemetry-bootstrap.ts");

	it("does not initialize an exporter for ordinary local execution", async () => {
		await load(); expect(registerOTel).not.toHaveBeenCalled();
	});
	it("initializes once per module lifetime with sanitization before automatic exporters", async () => {
		vi.stubEnv("VERCEL", "1");
		await load(); await load();
		expect(registerOTel).toHaveBeenCalledExactlyOnceWith({
			serviceName: "pi-agent-vercel", instrumentations: [], propagators: ["tracecontext"],
			spanProcessors: [expect.objectContaining({ onEnd: expect.any(Function) }), "auto"],
		});
	});
	it.each(["OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"])("allows an explicit local collector via %s", async (key) => {
		vi.stubEnv(key, "http://localhost:4318"); await load();
		expect(registerOTel).toHaveBeenCalledOnce();
	});
	it("respects the SDK disable switch even on Vercel", async () => {
		vi.stubEnv("VERCEL", "1"); vi.stubEnv("OTEL_SDK_DISABLED", "true");
		await load(); expect(registerOTel).not.toHaveBeenCalled();
	});
	it("keeps a broken SDK bootstrap out of execution", async () => {
		vi.stubEnv("VERCEL", "1");
		vi.mocked(registerOTel).mockImplementationOnce(() => { throw new Error("private-sdk-error"); });
		const telemetry = await load();
		await expect(telemetry.flushTelemetry()).resolves.toBeUndefined();
	});
	it.each(["reject", "timeout"])("does not fail CLI execution when flushing encounters %s", async (failure) => {
		vi.useFakeTimers(); vi.stubEnv("VERCEL", "1");
		const forceFlush = vi.fn(() => failure === "reject" ? Promise.reject(new Error("private-export-error")) : new Promise<void>(() => {}));
		vi.spyOn(trace, "getTracerProvider").mockReturnValue({ getTracer: vi.fn(), forceFlush } as TracerProvider);
		const telemetry = await load();
		const flushed = telemetry.flushTelemetry();
		await vi.advanceTimersByTimeAsync(1_000);
		await expect(flushed).resolves.toBeUndefined();
		expect(forceFlush).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
	});
});
