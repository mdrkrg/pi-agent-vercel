# Development

Use the Node and pnpm versions declared in [package.json](../package.json), plus a local Podman or Docker engine.

## Quick start

```sh
pnpm install
pnpm dev:faux
```

Open the UI URL printed by the runner and enter its access token (`local-api`). Click **Connect**, then **New chat** and **Send**.

This starts the database, backend and UI together. FAUX returns a fixed reply without model credentials or provider spending. It tests integration, not model reasoning.

## Configuration

`dev:faux` uses an isolated local database and fixed development credentials, overriding inherited cloud settings. It does not load `.env`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `DEV_DB_PORT` | `55432` | PostgreSQL host port |
| `DEV_SERVICE_PORT` | `3080` | Backend port and UI API proxy target |
| `DEV_UI_PORT` | `5173` | UI port |
| `DEV_FAUX_RESPONSE` | `This is a fixed FAUX response.` | Constant assistant response |
| `DEV_STACK_NAME` | `pi-agent-vercel-faux` | Namespace for isolated parallel checkouts |
| `DEV_CONTAINER_ENGINE` | automatic | Explicitly select `podman` or `docker` |

```sh
DEV_SERVICE_PORT=3081 DEV_UI_PORT=5174 pnpm dev:faux
```

## Local data

Development data survives restarts. After the runner exits:

```sh
pnpm dev:stop   # Stop a leftover development database, retain data.
pnpm dev:reset  # Permanently delete development data, with confirmation.
```

After a reset, use **Clear history** in the UI to discard references to the deleted database.

## Manual or real-provider development

Export server variables from [.env.example](../.env.example), then run these commands in separate terminals:

```sh
pnpm dev:service
pnpm dev:ui
```

The backend does not automatically load `.env`. With `AGENT_FAUX_RESPONSE` set it uses the deterministic provider, omit it and configure provider/model credentials for authorized real execution. See the [Function reference](function-runtime.md#provider-configuration).

The backend and UI proxy default to port 3000. If changing the backend's `PORT`, set the UI's `DEV_SERVICE_PORT` to match, for example `DEV_SERVICE_PORT=3080 pnpm dev:ui`.

## Deployed worker

With Vercel CLI installed and logged in, run a separate terminal process:

```sh
pnpm worker:external --url https://YOUR-DEPLOYMENT.vercel.app
```

- Reads `CRON_SECRET` from `.env` or the shell, never the API token. Use `--env-file <path>` to select a different credential file.
- Runs continuously, waiting **60s after each request** without overlapping requests. Stop with **Ctrl+C**. A `5xx` is logged and the next scheduled request still runs. Other failures exit.
- Preserves Preview Protection through `vercel curl`. Browser polling still only observes results.
- This is a foreground development helper, not a managed cloud scheduler. Idle requests keep Neon awake and consume quota, so stop it when done.

Set `EXTERNAL_WORKER_URL` in `.env` or the shell to use just `pnpm worker:external`. See `pnpm worker:external --help` for options.

## Chat UI

The UI is intentionally a small, sequential chat over the existing durable backend, not another agent runtime or a server-history browser. The backend progresses independently, browser polling only observes results.

For manual development, enter your configured `APP_API_TOKEN`. After refreshing, re-enter the token. If a submission needs recovery, use **Retry submission** rather than sending another copy.

This is a trusted-operator PoC, not a public login system. Local prompts are plaintext. Avoid shared devices and keep provider/database credentials server-side.

## Verification

```sh
pnpm check
pnpm docs:check
pnpm build
env -u DATABASE_URL pnpm test  # Non-SQL and frontend tests. SQL suites are skipped.
git diff --check
```

For SQL contracts, start a separate disposable PostgreSQL 16 container, point `DATABASE_URL` at it, run `pnpm test`, and stop/remove it afterward. **Never use the persistent FAUX development database or a business database**: SQL tests clean shared tables. Skipped SQL suites are not database evidence.

Enable the optional pre-commit document-link check with `prek install` (prek >=0.4.8).
