# Development

Use the Node and pnpm versions declared in [package.json](../package.json), plus an available local Podman or Docker engine. Corepack is not required.

## Quick start

```sh
pnpm install
pnpm dev:faux
```

Open `http://127.0.0.1:5173`, enter `local-api` in **Access token**, click **Connect**, then **New chat** and **Send**. Each turn returns `This is a fixed FAUX response.` No model credentials or provider spending are needed; FAUX verifies the request/execution/UI path, not model reasoning or context understanding.

The runner prints the UI/API URLs and `Access token: local-api (local FAUX only)`. This is a fixed public development token, not an inherited application credential; real-provider launch commands do not print their tokens.

The foreground launcher starts a dedicated PostgreSQL 16 database, waits for readiness, then uses concurrently to run the independently polling backend and Svelte UI. It prefers local Podman and falls back to local Docker; remote engines and Docker contexts are rejected.

## Configuration

The launcher forces a local `DATABASE_URL`, distinct development API/worker credentials, principal, budgets and FAUX mode regardless of inherited production configuration. It does not read `.env`. Backend and UI ports are passed together so the proxy stays aligned; all three services bind to loopback.

| Variable | Default | Purpose |
| --- | --- | --- |
| `DEV_DB_PORT` | `55432` | PostgreSQL host port |
| `DEV_SERVICE_PORT` | `3080` | Backend port and UI API proxy target |
| `DEV_UI_PORT` | `5173` | UI port; no automatic fallback if occupied |
| `DEV_FAUX_RESPONSE` | `This is a fixed FAUX response.` | Constant assistant response |
| `DEV_STACK_NAME` | `pi-agent-vercel-faux` | Namespace for isolated parallel checkouts |
| `DEV_CONTAINER_ENGINE` | automatic | Explicitly select `podman` or `docker` |

```sh
DEV_SERVICE_PORT=3081 DEV_UI_PORT=5174 pnpm dev:faux
```

## Lifecycle and isolation

- **Ctrl+C/SIGTERM** stops backend and UI, then the database started by this invocation. Either application exiting also stops the other and the database. The container and volume remain for restart recovery; startup failures retain data.
- **`pnpm dev:stop`** is an idempotent database-only recovery command. Exit the foreground runner first; this command does not search for or kill application PIDs.
- **`pnpm dev:reset`** requires typing the namespace before deleting its dedicated container and volume. Automation must explicitly pass `--yes`. It never force-removes a volume or globally prunes resources. After reset, use **Clear history** to remove browser records referencing the deleted database.
- Default resources are `pi-agent-vercel-faux-db` and `pi-agent-vercel-faux-pgdata`, labelled with checkout/namespace ownership. Unknown same-name resources, active containers, altered image/port settings and occupied ports fail closed instead of being taken over.
- Commands take an exclusive checkout/namespace lock. Hard termination can leave a lock directory: confirm the runner and children are gone, then remove only the empty lock path printed by the command. `dev:stop` can subsequently stop its orphaned, labelled database.
- Engine commands have a 120s timeout, including a first image download; interruption waits for an in-flight command before cleanup. Readiness polling allows 30s. Existing data is never automatically deleted or upgraded to another PostgreSQL major version.

## Manual or real-provider development

Export server variables from [.env.example](../.env.example), then run these commands in separate terminals:

```sh
pnpm dev:service
pnpm dev:ui
```

The backend does not automatically load `.env`. With `POC_FAUX_RESPONSE` set it uses the deterministic provider; omit it and configure provider/model credentials for authorized real execution. See the [Function reference](function-runtime.md#provider-configuration).

The manual backend defaults to port 3000, matching the standalone UI proxy. If changing `PORT`, set the same `DEV_SERVICE_PORT` for the UI, for example `DEV_SERVICE_PORT=3080 pnpm dev:ui`. `pnpm worker:once` runs one independent local worker tick; `dev:service` already supplies a local poller.

## Chat UI

On Vercel, the page at `/` uses same-origin API routes. Enter the configured `POC_API_TOKEN` in **Access token**, then **Connect** and **New chat**. Connecting only sets an in-memory credential; the first API request validates it. **Send** or `Ctrl/Cmd + Enter` submits a message. The next turn remains disabled until the current frozen result is read, including failed/cancelled outcomes.

The **?** below the composer opens an upward FAQ on hover, keyboard focus or tap. Escape, focus leaving the FAQ or clicking outside dismisses it. Errors and actionable status remain visible. Replies display escaped assistant text only, without Markdown/HTML interpretation or thinking/tool blocks.

- Queries **never call `/api/worker`**. Keep an independent scheduler running on Vercel; minute cron can add nearly a minute before execution. More polling does not accelerate it.
- Running reads poll every 2s; admission/waits and transient failures use 10s. Hidden pages pause queries and resume when visible; terminal results stop polling. Read failure/timeout never cancels work. `401`/`403` clears the credential and requires re-entry.
- **Retry submission** reuses the exact original prompt and `Idempotency-Key`, even after refreshing. A lost response may hide an already-admitted request: do not send another copy. Session creation is not automatically retried because its lost response can leave an unknown session id.
- Each page stores one chat, up to 50 turns and 65,536 characters per message. Drafts, prompts and session/submission/retry identities are plaintext in tab-local `sessionStorage`; tokens and assistant output are not persisted. After refresh, re-enter the token to re-read frozen outputs or retry an unconfirmed submission. Closing the tab can lose local history.
- A storage warning means refresh may lose retry identity: retain the page. **Clear history** removes local records and credentials, not server records or running work. A successful **New chat** replaces the local view without deleting the old conversation server-side.

This is a trusted-operator, single-principal PoC, not a public login system. Keep database/provider credentials and `CRON_SECRET` server-side; never put credentials in `VITE_*` variables or static assets. Avoid shared/untrusted devices because local prompts are plaintext. Preserve Preview Deployment Protection; platform access and API authentication are separate checks.

## Verification

```sh
pnpm check
pnpm docs:check
pnpm build
env -u DATABASE_URL pnpm test  # Non-SQL and frontend tests; SQL suites are skipped.
git diff --check
```

For SQL contracts, start a separate disposable PostgreSQL 16 container, point `DATABASE_URL` at it, run `pnpm test`, and stop/remove it afterward. **Never use the persistent FAUX development database or a business database**: SQL tests clean shared tables. Skipped SQL suites are not database evidence.

The optional pre-commit document-link check requires prek >=0.4.8; enable it with `prek install`. Cloud deployments, provider spending and destructive validation require explicit authorization; local FAUX checks do not qualify cloud deadlines, deployment switches or hard termination.
