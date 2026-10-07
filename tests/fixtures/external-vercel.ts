#!/usr/bin/env node
import { writeFile } from "node:fs/promises";

let stdin = "";
for await (const chunk of process.stdin) stdin += chunk.toString();
const path = process.env.TEST_EXTERNAL_WORKER_METADATA;
if (!path) throw new Error("Fixture metadata path is required");
await writeFile(
  path,
  JSON.stringify({
    args: process.argv.slice(2),
    workerHeaderMatched: stdin === "Authorization: Bearer worker-fixture-only\n",
  }),
);
process.stdout.write(
  JSON.stringify({
    discovered: 0,
    driven: [],
    pending: [],
    projections: [],
    privateDiagnostic: "fixture-private-response",
  }) + "\n401",
);
