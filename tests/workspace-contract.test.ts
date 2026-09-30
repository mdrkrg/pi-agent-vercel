import { describe, expect, it } from "vitest";
import { MemoryWorkspace } from "../packages/agent-runtime/src/index.ts";

describe("workspace capability contract", () => {
	it("keeps filesystem state host-neutral and rejects traversal", async () => {
		const workspace = new MemoryWorkspace();
		await workspace.write("data/input.bin", new Uint8Array([1, 2, 3]));
		expect([...await workspace.read("data/input.bin")]).toEqual([1, 2, 3]);
		expect(await workspace.list("data")).toEqual([{ path: "data/input.bin", size: 3 }]);
		await expect(workspace.read("../secret")).rejects.toThrow("relative");
	});
});
