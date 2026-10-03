# Pi Agent Vercel PoC

A resumable agent runtime for short-lived Functions: Pi owns agent semantics, PostgreSQL stores durable sessions, and an independent worker resumes execution.

## Local development

Requires Node 24 and pnpm 12.8.1; Corepack is not required.

```sh
pnpm install
pnpm check
pnpm docs:check
pnpm test
```

Enable the optional pre-commit check with `prek install` (prek >=0.4.8).

Set `DATABASE_URL` to run the PostgreSQL contracts; otherwise SQL suites are skipped. CI supplies disposable PostgreSQL 16.

`pnpm dev:service` starts HTTP plus an independent local poller; `pnpm worker:once` runs one worker tick.

For the Svelte live chat, run `pnpm dev:service` with server environment variables exported, then `pnpm dev:ui` in another terminal. Open `http://127.0.0.1:5173`, enter the API token, create a conversation, and send messages. `pnpm build` validates both backend and frontend and produces static assets in `dist/`.

Chat uses polling, not token streaming, and never drives execution. Keep an independent scheduler active on Vercel. Token stays in memory; prompts/retry identities are plaintext in tab-local `sessionStorage`. See [live chat usage](docs/function-runtime.md#live-chat) for refresh/retry behavior and security prerequisites, and the [Function reference](docs/function-runtime.md) for credentials, routes, and configuration.

## Vercel configuration

Deploy from repository root using the checked-in `vercel.mjs`.

- Runtime: Node 24; pnpm 12.8.1; Function limit 60s.
- UI: static Svelte/Vite build at `/`; existing `/api/*` routes remain unchanged.
- Environment: configure [.env.example](.env.example); Neon integration supplies `DATABASE_URL`.
- Providers: installed Pi built-ins; configure `AGENT_PROVIDER`, `AGENT_MODEL_ID`, and provider credentials.
- Scheduler: external by default on Hobby; `AGENT_WORKER_SCHEDULER=vercel-cron` enables every-minute cron on Pro/Enterprise.
- Worker: `/api/worker`, authenticated with `Authorization: Bearer <CRON_SECRET>`.

## Scope and documentation

This PoC supports one configured principal and one main lane. It does not promise exactly-once external effects or production readiness; Sandbox, streaming, and heavy delegated execution remain deferred.

- [Architecture](docs/architecture.md) and [durable contract](docs/operation-aware-contract.md): design and guarantees.
- [Implementation](docs/runtime-implementation.md): persistence and recovery mechanics.
- [Known gaps](docs/known-gaps.md): limits and production work.
