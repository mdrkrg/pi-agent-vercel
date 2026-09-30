import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["tests/**/*.test.ts"],
		// Database contract files intentionally clean shared tables in lifecycle
		// hooks; run them serially so one suite cannot delete another's fixtures.
		fileParallelism: false,
	},
});
