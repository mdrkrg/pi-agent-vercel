export type FunctionFailureStage =
  | "entry"
  | "cleanup"
  | "request"
  | "worker.bootstrap"
  | "worker.tick"
  | "api.bootstrap"
  | "api.request";

const codeCategories = new Map([
  ["57014", "database_statement_cancelled"],
  ["40P01", "database_deadlock"],
  ["40001", "database_serialization"],
  ["53300", "database_connection_limit"],
  ["57P01", "database_shutdown"],
  ["08001", "database_connection"],
  ["08003", "database_connection"],
  ["08006", "database_connection"],
  ["42P01", "database_missing_relation"],
  ["23505", "database_unique_violation"],
  ["42501", "database_permission"],
  ["ECONNRESET", "connection_reset"],
  ["ECONNREFUSED", "connection_refused"],
  ["ETIMEDOUT", "connection_timeout"],
  ["ENOTFOUND", "dns_failure"],
]);
const errorTypes = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "AbortError"]);

/** Log only fixed categories, never an exception, SQL, identity or request data. */
export function reportFunctionFailure(
  error: unknown,
  stage: FunctionFailureStage,
  elapsedMs: number,
  write: (message: string) => void = console.error,
): void {
  let category = "internal";
  let errorType = "other";
  try {
    if (error instanceof Error) {
      errorType = errorTypes.has(error.name) ? error.name : "other";
      const code: unknown = (error as Error & { code?: unknown }).code;
      if (typeof code === "string") category = codeCategories.get(code) ?? category;
      if (category === "internal") {
        if (error.message === "Query read timeout") category = "database_query_timeout";
        else if (
          error.message === "timeout exceeded when trying to connect" ||
          error.message === "Connection terminated due to connection timeout"
        )
          category = "database_connection_timeout";
        else if (error.message === "Function invocation budget exhausted")
          category = "invocation_deadline";
      }
    }
  } catch {
    /* An unusual exception getter must not interfere with the response. */
  }
  try {
    write(
      JSON.stringify({
        event: "function_internal_error",
        stage,
        category,
        errorType,
        elapsedMs: Number.isFinite(elapsedMs) ? Math.max(0, Math.round(elapsedMs)) : 0,
      }),
    );
  } catch {
    /* A failed logger must not change execution or response semantics. */
  }
}
