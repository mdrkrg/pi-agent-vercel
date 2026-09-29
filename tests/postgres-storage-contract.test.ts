import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core/harness/context";
import {
	createStorageConformance,
	type StorageFixture,
} from "@earendil-works/pi-agent-core/harness/session/testing";
import { afterAll, beforeAll, describe } from "vitest";
import { registerConformanceCases } from "../packages/contract-tests/src/register.ts";
import {
	deletePiPostgresSession,
	ensurePiPostgresSchema,
	PgExecutor,
	PostgresStorage,
} from "../packages/pi-postgres/src/index.ts";

const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(databaseUrl === undefined)("Postgres Storage contract", () => {
	const executor = new PgExecutor({ connectionString: databaseUrl });

	beforeAll(async () => {
		await ensurePiPostgresSchema(executor);
	});
	afterAll(async () => {
		await executor.close();
	});

	registerConformanceCases(createStorageConformance(asyncStorageFixture));

	async function asyncStorageFixture(): Promise<StorageFixture> {
		const sessionId = `contract-${randomUUID()}`;
		const storage = new PostgresStorage(executor, sessionId);
		return {
			storage,
			async [Symbol.asyncDispose](): Promise<void> {
				await storage.close(BACKGROUND_CONTEXT);
				await deletePiPostgresSession(executor, sessionId);
			},
		};
	}
});
