import {
	createSessionRepoForkConformance,
	createSessionRepoLifecycleConformance,
	createSessionRepoMessageConformance,
	createSessionRepoOwnershipConformance,
} from "@earendil-works/pi-agent-core/harness/session/testing";
import { afterAll, beforeAll, describe } from "vitest";
import { registerConformanceCases } from "../packages/contract-tests/src/register.ts";
import {
	ensurePiPostgresSchema,
	PgExecutor,
	PostgresSessionRepo,
} from "../packages/pi-postgres/src/index.ts";

const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(databaseUrl === undefined)("Postgres SessionRepo contract", () => {
	const executor = new PgExecutor({ connectionString: databaseUrl });

	beforeAll(async () => {
		await ensurePiPostgresSchema(executor);
		await clearDatabase();
	});
	afterAll(async () => {
		await clearDatabase();
		await executor.close();
	});

	registerConformanceCases([
		...createSessionRepoLifecycleConformance(sessionRepoFactory),
		...createSessionRepoMessageConformance(sessionRepoFactory),
		...createSessionRepoOwnershipConformance(sessionRepoFactory),
		...createSessionRepoForkConformance(sessionRepoFactory),
	]);

	async function sessionRepoFactory(): Promise<PostgresSessionRepo> {
		await clearDatabase();
		return new PostgresSessionRepo(executor);
	}

	async function clearDatabase(): Promise<void> {
		await executor.transaction(async (transaction) => {
			await transaction.query("DELETE FROM agent_session_leases");
			await transaction.query("DELETE FROM pi_poc_storage_entries");
			await transaction.query("DELETE FROM pi_poc_storage_values");
			await transaction.query("DELETE FROM pi_poc_storage_lists");
			await transaction.query("DELETE FROM pi_poc_storage_usage");
			await transaction.query("DELETE FROM pi_poc_storage_sequences");
			await transaction.query("DELETE FROM agent_service_session_access");
			await transaction.query("DELETE FROM pi_poc_sessions");
		});
	}
});
