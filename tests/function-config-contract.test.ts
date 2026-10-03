import { getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFunctionServiceFromEnv } from "../packages/agent-runtime/src/function-config.ts";
import { FunctionService } from "../packages/agent-runtime/src/function-service.ts";
import { PgExecutor } from "../packages/pi-postgres/src/index.ts";

// Configuration contracts must not connect to PostgreSQL or call real providers.
vi.mock("../packages/agent-runtime/src/function-service.ts", () => ({ FunctionService: vi.fn(function () {}) }));
vi.mock("../packages/pi-postgres/src/index.ts", () => ({ PgExecutor: vi.fn(function () {}) }));

const base: NodeJS.ProcessEnv = {
	DATABASE_URL: "postgresql://unused/isolated-test",
	POC_API_TOKEN: "test-api", CRON_SECRET: "test-worker",
	POC_USER_ID: "test-user", POC_TENANT_ID: "test-tenant",
	AGENT_PROVIDER: "deepseek", AGENT_MODEL_ID: "deepseek-flash",
};
function configure(overrides: NodeJS.ProcessEnv = {}) {
	createFunctionServiceFromEnv({ ...base, ...overrides });
	return vi.mocked(FunctionService).mock.calls.at(-1)![0];
}

describe("Function environment configuration (no database or provider calls)", () => {
	afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); });

	it("registers the entire installed built-in catalog and selects DeepSeek", () => {
		const options = configure();
		for (const provider of getBuiltinProviders()) expect(options.models.getProvider(provider)).toBeDefined();
		expect(options.model).toMatchObject({ provider: "deepseek", id: "deepseek-flash" });
		expect(options.models.getProvider("faux")).toBeUndefined();
		expect(options).toMatchObject({ apiToken: "test-api", cronSecret: "test-worker", principal: { userId: "test-user", tenantId: "test-tenant", scopes: ["agent:run"] }, maxPassMs: 45_000, maxInvocationMs: 55_000, maxAdmissionMs: 10_000 });
		expect(vi.mocked(PgExecutor).mock.calls[0]![0]).toMatchObject({ connectionString: base.DATABASE_URL, max: 4 });
	});

	it.each(["openai", "anthropic", "google", "openrouter", "groq", "mistral"])("selects an installed %s model without credentials", (provider) => {
		const catalog = configure().models;
		const model = catalog.getModels(provider)[0]!;
		expect(model).toBeDefined();
		expect(configure({ AGENT_PROVIDER: provider, AGENT_MODEL_ID: model.id }).model).toEqual(model);
	});

	it.each([
		["deepseek", "DEEPSEEK_API_KEY"], ["openai", "OPENAI_API_KEY"],
		["google", "GEMINI_API_KEY"], ["openrouter", "OPENROUTER_API_KEY"],
	])("delegates %s environment-key resolution to Pi", async (provider, keyName) => {
		vi.stubEnv(keyName, "fake-config-test-key");
		const { models } = configure();
		const auth = await models.getAuth(provider);
		expect(auth?.auth.apiKey).toBe("fake-config-test-key");
		expect(auth?.source).toBe(keyName);
	});

	it.each([
		[{ AGENT_PROVIDER: "unknown-provider" }, "Configured provider is absent"],
		[{ AGENT_MODEL_ID: "not-in-catalog" }, "Configured model is absent"],
		[{ AGENT_PROVIDER: undefined }, "AGENT_PROVIDER is required"],
		[{ AGENT_MODEL_ID: "" }, "AGENT_MODEL_ID is required"],
	])("rejects invalid model selection before allocating a database pool: %j", (overrides, error) => {
		expect(() => configure(overrides)).toThrow(error);
		expect(PgExecutor).not.toHaveBeenCalled(); expect(FunctionService).not.toHaveBeenCalled();
	});

	it("keeps faux mode isolated and usable without provider selection or keys", async () => {
		const { models, model } = configure({ POC_FAUX_RESPONSE: "deterministic response", AGENT_PROVIDER: undefined, AGENT_MODEL_ID: undefined });
		expect(models.getProviders()).toHaveLength(1);
		expect(model.provider).not.toBe("deepseek");
		expect(models.getProvider("deepseek")).toBeUndefined();
		const message = await models.complete(model, { messages: [] });
		expect(message.content).toEqual([{ type: "text", text: "deterministic response" }]);
	});

	it("allows a measured cloud admission budget with cleanup headroom", () => {
		expect(configure({ AGENT_ADMISSION_MS: "25000" }).maxAdmissionMs).toBe(25_000);
	});

	it.each([
		{ AGENT_ADMISSION_MS: "50000" }, { AGENT_ADMISSION_MS: "0" },
		{ AGENT_ADMISSION_MS: "invalid" },
		{ AGENT_PASS_MS: "50000", AGENT_INVOCATION_MS: "55000" },
		{ AGENT_INVOCATION_MS: "56000" }, { AGENT_PASS_MS: "0" },
		{ AGENT_INVOCATION_MS: "invalid" },
	])("preserves bounded execution validation: %j", (overrides) => {
		expect(() => configure(overrides)).toThrow(); expect(PgExecutor).not.toHaveBeenCalled();
	});
});
