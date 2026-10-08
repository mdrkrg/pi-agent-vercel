# Pi Agent Vercel PoC

A resumable agent runtime for short-lived Functions: Pi owns agent semantics, PostgreSQL stores durable sessions, and an independent worker resumes execution.

## Local development

Start the local FAUX chat with Podman/Docker. See [Development](docs/development.md) for setup, configuration and verification.

```sh
pnpm install
pnpm dev:faux   # http://127.0.0.1:5173
# Ctrl+C stops the stack and keeps database data.
pnpm dev:stop   # Stop a leftover development database after exiting the runner.
pnpm dev:reset  # Confirm before deleting development data.
```

## Vercel configuration

Deploy from repository root using the checked-in `vercel.mjs`. See the [Function reference](docs/function-runtime.md) for the HTTP contract and deployment settings.

- Runtime: Node 24, pnpm 12.8.1. Function limit 300s with Fluid compute.
- UI: static Svelte/Vite build at `/`, existing `/api/*` routes remain unchanged.
- Environment: configure [.env.example](.env.example). Neon integration supplies `DATABASE_URL`.
- Providers: installed Pi built-ins, configure `AGENT_PROVIDER`, `AGENT_MODEL_ID`, and provider credentials.
- Scheduler: external by default on Hobby, `AGENT_WORKER_SCHEDULER=vercel-cron` enables every-minute cron on Pro/Enterprise.
- Worker: `/api/worker`, authenticated with `Authorization: Bearer <CRON_SECRET>`.

## Scope and documentation

This PoC supports one configured principal and one main lane. It does not promise exactly-once external effects or production readiness. Sandbox, streaming, and heavy delegated execution are deferred.

- [Architecture](docs/architecture.md) and [durable contract](docs/operation-aware-contract.md): design and guarantees.
- [Implementation](docs/runtime-implementation.md): persistence and recovery mechanics.
- [Known gaps](docs/known-gaps.md): limits and production work.
