import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { PgExecutor } from "../../pi-postgres/src/index.ts";
import { FunctionService } from "./function-service.ts";

function required(env: NodeJS.ProcessEnv, key: string): string {
	const value = env[key]; if (value === undefined || value.length === 0) throw new Error(`${key} is required`); return value;
}
function milliseconds(value: string | undefined, fallback: number): number {
	const parsed = value === undefined ? fallback : Number(value);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error("Execution budgets must be positive integers"); return parsed;
}

export function createFunctionServiceFromEnv(env: NodeJS.ProcessEnv = process.env): FunctionService {
	const models = env.POC_FAUX_RESPONSE === undefined ? builtinModels() : createModels(); let model;
	if (env.POC_FAUX_RESPONSE !== undefined) {
		const faux = fauxProvider(); models.setProvider(faux.provider); faux.setResponses([fauxAssistantMessage(env.POC_FAUX_RESPONSE)]); model = faux.getModel();
	} else {
		const provider = required(env, "AGENT_PROVIDER");
		if (models.getProvider(provider) === undefined) throw new Error("Configured provider is absent from the installed Pi catalog");
		model = models.getModel(provider, required(env, "AGENT_MODEL_ID"));
		if (model === undefined) throw new Error("Configured model is absent from the installed Pi catalog");
	}
	const maxPassMs = milliseconds(env.AGENT_PASS_MS, 45_000); const maxInvocationMs = milliseconds(env.AGENT_INVOCATION_MS, 55_000);
	const maxAdmissionMs = milliseconds(env.AGENT_ADMISSION_MS, 10_000);
	if (Math.max(maxPassMs, maxAdmissionMs) + 6_000 > maxInvocationMs || maxInvocationMs > 55_000) throw new Error("Invocation budget must reserve cleanup time and fit the 60s Function limit");
	const apiToken = required(env, "POC_API_TOKEN"); const cronSecret = required(env, "CRON_SECRET");
	const principal = { userId: required(env, "POC_USER_ID"), tenantId: required(env, "POC_TENANT_ID"), scopes: ["agent:run"] };
	const executor = new PgExecutor({ connectionString: required(env, "DATABASE_URL"), max: 4, connectionTimeoutMillis: 5_000, idleTimeoutMillis: 10_000, statement_timeout: 5_000, query_timeout: 6_000 });
	return new FunctionService({ executor, models, model, apiToken, cronSecret, principal, maxPassMs, maxInvocationMs, maxAdmissionMs });
}
