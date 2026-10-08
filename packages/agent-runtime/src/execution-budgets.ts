import budgets from "./execution-budgets.json" with { type: "json" };

export const FUNCTION_MAX_DURATION_MS = budgets.functionMaxDurationSeconds * 1_000;
export const DEFAULT_INVOCATION_MS = FUNCTION_MAX_DURATION_MS - budgets.headroomMs;
export const DEFAULT_PASS_MS = DEFAULT_INVOCATION_MS - budgets.headroomMs;
export const MIN_CLEANUP_MS = budgets.minCleanupMs;
