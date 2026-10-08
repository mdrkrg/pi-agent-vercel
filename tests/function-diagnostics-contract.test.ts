import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable, Writable } from "node:stream";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reportFunctionFailure } from "../packages/agent-runtime/src/function-diagnostics.ts";
import { FunctionService } from "../packages/agent-runtime/src/function-service.ts";
import { PgExecutor } from "../packages/pi-postgres/src/index.ts";

const privateData = "fixture-private-credential-prompt-and-sql";
afterEach(() => vi.restoreAllMocks());

describe("redacted Function diagnostics", () => {
  it.each([
    ["57014", "database_statement_cancelled"],
    ["40P01", "database_deadlock"],
    ["ETIMEDOUT", "connection_timeout"],
    [privateData, "internal"],
  ])("classifies known error codes without echoing errors: %s", (code, category) => {
    const write = vi.fn();
    const error = Object.assign(new Error(privateData), {
      code,
      detail: privateData,
      query: privateData,
      cause: new Error(privateData),
    });
    reportFunctionFailure(error, "worker.bootstrap", 19.4, write);
    expect(write).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({
        event: "function_internal_error",
        stage: "worker.bootstrap",
        category,
        errorType: "Error",
        elapsedMs: 19,
      }),
    );
    expect(write.mock.calls.flat().join("\n")).not.toContain(privateData);
  });

  it.each([
    ["Query read timeout", "database_query_timeout"],
    ["Connection terminated due to connection timeout", "database_connection_timeout"],
    ["Function invocation budget exhausted", "invocation_deadline"],
  ])("recognizes fixed timeout signatures: %s", (message, category) => {
    const write = vi.fn();
    reportFunctionFailure(new Error(message), "worker.tick", 1, write);
    expect(JSON.parse(write.mock.calls[0]![0]).category).toBe(category);
  });

  it("does not echo thrown strings, custom error names or unusual getters", () => {
    const write = vi.fn();
    for (const error of [
      privateData,
      Object.assign(new Error(privateData), { name: privateData }),
      Object.defineProperty(new Error(privateData), "code", {
        get() {
          throw new Error(privateData);
        },
      }),
    ]) {
      reportFunctionFailure(error, "entry", 0, write);
    }
    expect(write).toHaveBeenCalledTimes(3);
    expect(write.mock.calls.flat().join("\n")).not.toContain(privateData);
  });

  it("does not propagate logger failures", () => {
    expect(() =>
      reportFunctionFailure(new Error(privateData), "cleanup", 0, () => {
        throw new Error(privateData);
      }),
    ).not.toThrow();
  });
});

class Response extends Writable {
  statusCode = 200;
  data = "";
  setHeader(_name: string, _value: string) {}
  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    this.data += chunk.toString();
    callback();
  }
}

describe("Function service error boundary (no database or provider calls)", () => {
  async function invoke(failure: "bootstrap" | "tick" | "authorization") {
    const models = createModels();
    const faux = fauxProvider();
    models.setProvider(faux.provider);
    const service = new FunctionService({
      executor: new PgExecutor({
        connectionString: "postgresql://unused/isolated-diagnostic-test",
      }),
      models,
      model: faux.getModel(),
      apiToken: "fixture-api",
      cronSecret: "fixture-worker",
      principal: { userId: "fixture-user", tenantId: "fixture-tenant", scopes: ["agent:run"] },
    });
    const ready = vi.spyOn(service, "ready").mockResolvedValue(undefined);
    const tick = vi
      .spyOn(service.worker, "tick")
      .mockResolvedValue({ pending: [], discovered: 0, driven: [], projections: [] });
    const error = Object.assign(new Error(privateData), { code: "57014" });
    if (failure === "bootstrap") ready.mockRejectedValue(error);
    if (failure === "tick") tick.mockRejectedValue(error);
    const logger = vi.spyOn(console, "error").mockImplementation(() => {});
    const request = Object.assign(Readable.from([]), {
      url: "/api/worker",
      method: "POST",
      headers: {
        authorization:
          failure === "authorization" ? "Bearer wrong-fixture" : "Bearer fixture-worker",
      },
    });
    const response = new Response();
    try {
      await service.handle(
        request as unknown as IncomingMessage,
        response as unknown as ServerResponse,
      );
    } finally {
      await service.close();
    }
    return { response, logger, ready, tick };
  }

  it.each(["bootstrap", "tick"] as const)(
    "logs the %s stage while preserving the generic 500 response",
    async (stage) => {
      const { response, logger, tick } = await invoke(stage);
      expect(response.statusCode).toBe(500);
      expect(JSON.parse(response.data)).toEqual({ error: "Internal error" });
      expect(logger).toHaveBeenCalledTimes(1);
      expect(JSON.parse(logger.mock.calls[0]![0])).toMatchObject({
        event: "function_internal_error",
        stage: `worker.${stage}`,
        category: "database_statement_cancelled",
        errorType: "Error",
      });
      expect(logger.mock.calls.flat().join("\n") + response.data).not.toContain(privateData);
      if (stage === "bootstrap") expect(tick).not.toHaveBeenCalled();
    },
  );

  it("does not log expected authentication errors or initialize the database", async () => {
    const { response, logger, ready, tick } = await invoke("authorization");
    expect(response.statusCode).toBe(401);
    expect(logger).not.toHaveBeenCalled();
    expect(ready).not.toHaveBeenCalled();
    expect(tick).not.toHaveBeenCalled();
  });
});
