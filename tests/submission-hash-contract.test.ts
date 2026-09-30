import { describe, expect, it } from "vitest";
import { submissionRequestHash } from "../packages/pi-postgres/src/index.ts";

describe("submission request fingerprint", () => {
	it("is stable for the same UTF-8 prompt and changes with content", () => {
		expect(submissionRequestHash("hello")).toBe(submissionRequestHash("hello"));
		expect(submissionRequestHash("hello")).not.toBe(submissionRequestHash("hello "));
		expect(submissionRequestHash("你好")).toHaveLength(64);
	});
});
