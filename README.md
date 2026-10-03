# Pi Agent Vercel PoC

A resumable agent runtime for short-lived Functions: Pi owns agent semantics, PostgreSQL stores durable sessions, and an independent worker resumes execution.

## Local development

Requires Node 24 and pnpm 12.8.1; Corepack is not required.

```sh
pnpm install
pnpm check
pnpm test
```

Set `DATABASE_URL` to run the PostgreSQL contracts; otherwise SQL suites are skipped. CI supplies disposable PostgreSQL 16.

`pnpm dev:service` starts HTTP plus an independent local poller; `pnpm worker:once` runs one worker tick. See the [Function reference](docs/function-runtime.md) for credentials, routes, and configuration.

## Vercel configuration

Deploy from repository root using the checked-in `vercel.mjs`.

- Runtime: Node 24; pnpm 12.8.1; Function limit 60s.
- Environment: configure [.env.example](.env.example); Neon integration supplies `DATABASE_URL`.
- Providers: installed Pi built-ins; configure `AGENT_PROVIDER`, `AGENT_MODEL_ID`, and provider credentials.
- Scheduler: external by default on Hobby; `AGENT_WORKER_SCHEDULER=vercel-cron` enables every-minute cron on Pro/Enterprise.
- Worker: `/api/worker`, authenticated with `Authorization: Bearer <CRON_SECRET>`.

## Scope and documentation

This PoC supports one configured principal and one main lane. It does not promise exactly-once external effects or production readiness; Sandbox, streaming, and heavy delegated execution remain deferred.

- [Architecture](docs/architecture.md) and [durable contract](docs/operation-aware-contract.md): design and guarantees.
- [Implementation](docs/runtime-implementation.md): persistence and recovery mechanics.
- [Known gaps](docs/known-gaps.md): limits and production work.
