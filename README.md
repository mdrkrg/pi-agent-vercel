# Pi Agent Vercel PoC

This repository is a contract-first durability spike around the published `@earendil-works/pi-agent-core` package. Pi owns AgentHarness operation semantics; Postgres owns durable session state; the runtime wrapper acquires a fenced session lease for each drive pass.

Install and verify with pnpm 12 and the project runtime (Corepack is not required):

```sh
pnpm install
pnpm run check
pnpm test
```

Postgres contract suites run when `DATABASE_URL` is set. They cover Pi Storage and SessionRepo conformance, lease/fencing behavior, fresh-process recovery, provider/tool effect recovery, idempotent submissions, delegated task lifecycle, and concurrent admission. Without a database, the deterministic runtime contracts still run and database suites are skipped.

The Function PoC now includes recoverable admission input, fenced bounded drives, an independent worker, authenticated session/submission/result endpoints, and status reconciliation from immutable Pi results. `pnpm dev:service` runs an HTTP server with an independent local poller; `pnpm worker:once` runs a fresh worker tick. See [Function configuration and routes](docs/function-runtime.md).

Pi owns the effect sandwich and crash detection. External exactly-once execution is not promised; safe/never replay follows native Pi semantics. Sandbox, streaming outbox, and delegated heavy execution are deferred while their architecture interfaces remain available.

The Vercel entry and one-minute authenticated cron are configured but have not been deployed. That cron requires Pro/Enterprise. The HTTP shell uses one configured API principal; full-session discovery and request-time schema bootstrap are small-PoC boundaries.

The repository CI workflow starts PostgreSQL 16 and runs the full contract suite with `DATABASE_URL`, including fresh-process recovery and control-state tests.
