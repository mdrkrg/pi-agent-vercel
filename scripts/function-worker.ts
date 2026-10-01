import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core/harness/context";
import { createFunctionServiceFromEnv } from "../packages/agent-runtime/src/function-config.ts";

const service = createFunctionServiceFromEnv();
try { await service.ready(); process.stdout.write(`${JSON.stringify(await service.worker.tick(BACKGROUND_CONTEXT))}\n`); }
finally { await service.close(); }
