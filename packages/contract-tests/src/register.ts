import type { ConformanceCase } from "@earendil-works/pi-agent-core/harness/session/testing";
import { it } from "vitest";

export function registerConformanceCases(cases: readonly ConformanceCase[]): void {
	for (const testCase of cases) {
		it(`${testCase.group}: ${testCase.name}`, testCase.run);
	}
}
