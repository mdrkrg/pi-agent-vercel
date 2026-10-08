import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import handler from "../api/index.ts";
import { createFunctionServiceFromEnv } from "../packages/agent-runtime/src/function-config.ts";

vi.mock("../packages/agent-runtime/src/function-config.ts", () => ({
  createFunctionServiceFromEnv: vi.fn(),
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
});
const privateData = "fixture-private-entry-error";
class Response extends Writable {
  statusCode = 200;
  data = "";
  setHeader(_name: string, _value: string) {}
  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    this.data += chunk.toString();
    callback();
  }
}
const request = () =>
  Object.assign(Readable.from([]), {
    url: "/api/worker",
    method: "POST",
    headers: {},
  }) as unknown as IncomingMessage;

describe("Function entry diagnostics", () => {
  it("logs constructor failure without leaking configuration or changing the generic response", async () => {
    vi.mocked(createFunctionServiceFromEnv).mockImplementation(() => {
      throw new Error(privateData);
    });
    const logger = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = new Response();
    await handler(request(), response as unknown as ServerResponse);
    expect(response.statusCode).toBe(500);
    expect(JSON.parse(response.data)).toEqual({
      error: "Function configuration or database unavailable",
    });
    expect(JSON.parse(logger.mock.calls[0]![0])).toMatchObject({
      stage: "entry",
      category: "internal",
    });
    expect(logger.mock.calls.flat().join("\n") + response.data).not.toContain(privateData);
  });

  it("logs cleanup failure and lets the host see only a safe exception", async () => {
    const close = vi.fn().mockRejectedValue(new Error(privateData));
    vi.mocked(createFunctionServiceFromEnv).mockReturnValue({
      handle: async (_request: unknown, response: ServerResponse) => {
        response.end("{}");
      },
      close,
    } as unknown as ReturnType<typeof createFunctionServiceFromEnv>);
    const logger = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(handler(request(), new Response() as unknown as ServerResponse)).rejects.toThrow(
      "Function cleanup failed",
    );
    expect(close).toHaveBeenCalledTimes(1);
    expect(JSON.parse(logger.mock.calls[0]![0])).toMatchObject({
      stage: "cleanup",
      category: "internal",
    });
    expect(logger.mock.calls.flat().join("\n")).not.toContain(privateData);
  });
});
