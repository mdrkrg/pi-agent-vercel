# Pi Agent Vercel PoC

This repository is a contract-first durability spike around the published `@earendil-works/pi-agent-core` package. Pi owns AgentHarness operation semantics; Postgres owns durable session state; the runtime wrapper acquires a fenced session lease for each drive pass.

Install and verify with pnpm 12 and the project runtime (Corepack is not required):

```sh
pnpm install
pnpm run check
pnpm test
```

Postgres contract suites run when `DATABASE_URL` is set. They cover Pi Storage and SessionRepo conformance, lease/fencing behavior, fresh-process recovery, provider/tool effect recovery, idempotent submissions, delegated task lifecycle, and concurrent admission. Without a database, the deterministic runtime contracts still run and database suites are skipped.

The runtime includes the product submission boundary, identity-only drive scheduler, workload-aware Function/Sandbox host contracts, delegated work state, workspace capabilities, and hardening helpers. Postgres remains the authoritative store; workflow payloads carry identities and references rather than transcript or credential data.

The repository CI workflow starts PostgreSQL 16 and runs the full contract suite with `DATABASE_URL`, including fresh-process recovery and control-state tests.

A Vercel-compatible Node Function entrypoint and local runner are available for service validation. See [`docs/local-vercel.md`](docs/local-vercel.md); start it with `DATABASE_URL=... pnpm run local:vercel`. The local runner simulates the Function/API boundary and an in-process workflow adapter, not Vercel's control plane.
