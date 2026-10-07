import {
  externalWorkerConfig,
  ExternalWorkerError,
  EXTERNAL_WORKER_HELP,
  runExternalWorker,
} from "./external-worker.ts";

try {
  const config = await externalWorkerConfig(process.argv.slice(2));
  if (config === undefined) console.log(EXTERNAL_WORKER_HELP);
  else {
    console.log(`External worker: ${config.url} · Ctrl+C to stop`);
    await runExternalWorker(config);
  }
} catch (error) {
  console.error(
    error instanceof ExternalWorkerError ? error.message : "External worker scheduler failed.",
  );
  process.exitCode = 1;
}
