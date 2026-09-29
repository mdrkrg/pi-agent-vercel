# Pi Agent Vercel PoC

This repository is a contract-first durability spike around the published `@earendil-works/pi-agent-core` package. Pi owns AgentHarness operation semantics; Postgres owns durable session state; the runtime wrapper acquires a fenced session lease for each drive pass.

Install and verify with pnpm 12 and the project runtime:

```sh
corepack pnpm@12 install
corepack pnpm@12 runtime set node 26
corepack pnpm@12 run check
corepack pnpm@12 test
```

Postgres contract suites run when `DATABASE_URL` is set. They cover Pi Storage and SessionRepo conformance, lease/fencing behavior, and fresh-process recovery. Without a database, the deterministic AgentHarness contracts still run and database suites are skipped.

The implementation deliberately stops before HTTP ingress, Vercel Workflow integration, streaming, and Sandbox hosts. Those layers should reuse the same session and operation identities after the Postgres fresh-process spike is exercised against a real database.
