import { registerOTel } from "@vercel/otel";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@vercel/otel", () => ({ registerOTel: vi.fn() }));

describe("explicit Node telemetry bootstrap (no exports)", () => {
	beforeEach(() => {
		vi.resetModules(); vi.clearAllMocks();
		for (const key of ["VERCEL", "OTEL_SDK_DISABLED", "OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"]) vi.stubEnv(key, undefined);
	});
	afterEach(() => vi.unstubAllEnvs());
	const load = () => import("../packages/agent-runtime/src/telemetry-bootstrap.ts");

	it("does not initialize an exporter for ordinary local execution", async () => {
		await load(); expect(registerOTel).not.toHaveBeenCalled();
	});
	it("initializes once per module lifetime on Vercel, without fetch/header capture", async () => {
		vi.stubEnv("VERCEL", "1");
		await load(); await load();
		expect(registerOTel).toHaveBeenCalledExactlyOnceWith({ serviceName: "pi-agent-vercel", instrumentations: [], propagators: ["tracecontext"] });
	});
	it.each(["OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"])("allows an explicit local collector via %s", async (key) => {
		vi.stubEnv(key, "http://localhost:4318"); await load();
		expect(registerOTel).toHaveBeenCalledOnce();
	});
	it("respects the SDK disable switch even on Vercel", async () => {
		vi.stubEnv("VERCEL", "1"); vi.stubEnv("OTEL_SDK_DISABLED", "true");
		await load(); expect(registerOTel).not.toHaveBeenCalled();
	});
});
