# Function reference

Commands, HTTP contract, and deployment settings for the single-principal Function PoC. Design lives in [architecture](architecture.md); persistence/recovery mechanics live in [implementation](runtime-implementation.md).

## Local commands

Set the server environment from [.env.example](../.env.example); keep credentials out of Git.

- `pnpm dev:service`: HTTP server with an independent local poller.
- `pnpm dev:ui`: Svelte/Vite chat at `http://127.0.0.1:5173`, proxying `/api` to `http://127.0.0.1:3000`.
- `pnpm build`: validate backend/frontend and build static chat into `dist/`.
- `pnpm worker:once`: one fresh local worker tick.
- `pnpm check` / `pnpm test`: backend/frontend checks and tests; SQL suites need `DATABASE_URL`.

### Live chat

Run `pnpm dev:service` with server environment variables exported, then `pnpm dev:ui` in another terminal. The default proxy assumes service port 3000; update the Vite proxy if using a different `PORT`. On Vercel, the static page at `/` uses the same-origin API directly. No new server credentials or API routes are required.

Enter `POC_API_TOKEN` in **访问密钥**, click **连接**, create a conversation with **新建对话**, then send a message. Connecting sets an in-memory credential; the first API request validates it. `Ctrl/Cmd + Enter` sends; the next round stays disabled until the current frozen result is read. Only assistant text is displayed, without Markdown/HTML interpretation or thinking/tool blocks.

The viewport centers the chat with a scrollable message area. The **?** below the composer opens an upward FAQ on hover/focus (or tap), covering scheduling, browser storage, retry behavior and input limits. Escape, focus leaving the FAQ, or clicking outside dismisses it. Current errors and actionable status stay visible rather than being hidden in help.

- The page polls status/result; it never calls `/api/worker`. Keep an independent scheduler running. Minute cron can add nearly a minute before execution starts; polling faster does not reduce that delay.
- Running reads poll every 2s; admission/waits and transient errors use 10s. Hidden pages pause querying and resume when visible. Terminal results stop polling. Read failures/timeouts do not cancel or terminalize work; `401`/`403` require fresh credentials.
- A lost submission response keeps the exact prompt and `Idempotency-Key`. **重试提交** reuses both, including after a refresh. Session creation is not automatically retried because a lost response can leave an owned session whose id is unknown.
- The page keeps one conversation, up to 50 rounds. `sessionStorage` holds draft, prompt text, session/submission ids and retry keys for this tab; Token and assistant output are not persisted. After refresh, re-enter Token to query frozen outputs or retry an unconfirmed submission. This is not a server-side history browser or a guarantee of recovery after closing the tab.
- Storage failure is visibly warned: retain the page because refresh may lose retry identity. **清除记录** removes browser records and credentials, not server records or running work. New conversation replaces this tab's old record after successful creation, without deleting it server-side.

The page is for trusted operators of the single configured principal, not a public login system. Use only the API token in the browser; database/provider credentials and `CRON_SECRET` remain server-side. Never put credentials in `VITE_*` variables or static assets. Preserve Preview Deployment Protection; its access check is separate from API authentication. Browser prompt storage is plaintext and should not be used on shared/untrusted devices.

## Authentication and routes

API requests use `Authorization: Bearer <POC_API_TOKEN>`; worker requests use a distinct `CRON_SECRET`. Ownership checks require both **userId AND tenantId** to match the configured principal. Identity headers are ignored; unknown and unauthorized resources return the same `404`.

| Route | Authorization | Response |
| --- | --- | --- |
| `POST /api/sessions` | API token | Owned session, `201` |
| `POST /api/sessions/:id/fork` | API token, source ownership | Owned fork, `201` |
| `POST /api/sessions/:id/messages` | API token, session ownership, `Idempotency-Key` | Durable submission, `202` |
| `GET /api/submissions/:id` | API token, submission ownership | Native status/result projection |
| `GET /api/submissions/:id/result` | API token, submission ownership | Frozen result/output; unfinished `409` |
| `GET` or `POST /api/worker` | Worker token | One independent tick |

Message input is `{"prompt":"..."}`: prompt must contain 1–65,536 characters; `Idempotency-Key` must contain 1–256 characters. Within a session, the same key/payload converges on one submission; changed payload returns `409`. Status/result polling does not drive execution.

### Fork requests

`scope` is required; optional `id` chooses the destination:

| Scope | Fields | Copy |
| --- | --- | --- |
| `tree` | `{"scope":"tree"}`; no `branch`, `entryId`, or `position` | Conversation tree and branch tips |
| `branch` | Required configured AgentLane `branch`; optional `entryId`, `position` | One lane's path; entry defaults to current tip |

For branch scope, `position` is `at` (default, includes entry) or `before` (stops at parent). The entry must be on current-tip ancestry. Supplied string fields must be nonempty.

- Missing/unauthorized source: `404`, checked before body validation.
- Invalid scope/fields, unknown or data-only branch, unknown/off-branch entry: `400`.
- Success: `201`, `{"session": <metadata>}` including `parentSessionId` and atomic user/tenant ownership.
- Existing destination: `409`, unchanged. Fork is not idempotent; no blind retry.

The fork retains the source's user/tenant ownership and accepts fresh messages from that owner. Cross-user or cross-tenant access/fork attempts return `404`.

Fork lanes start idle; operation/pending/result/usage and submission/job state are excluded. Tree copies application values/lists; branch does not. Snapshot/transaction details are in [implementation](runtime-implementation.md).

## Provider configuration

`AGENT_PROVIDER` and `AGENT_MODEL_ID` select one model from the installed Pi built-ins. Pi resolves standard provider credential variables, such as `DEEPSEEK_API_KEY`. Unknown provider/model fails configuration; automatic failover is disabled.

`POC_FAUX_RESPONSE` selects an isolated deterministic provider; omit it for real execution. The environment entry configures no tools; programmatic `FunctionService` options can supply them.

Credentials stay server-side. This entry does not load coding-agent `auth.json`, `models.json`, or extensions, or configure persistent OAuth refresh. Provider bundle size and cold-start behavior need deployment measurement.

## Budgets and connections

| Setting | Default / constraint |
| --- | --- |
| `AGENT_ADMISSION_MS` | API admission ownership: 10,000ms; worker recovery remains 10,000ms |
| `AGENT_PASS_MS` | Drive pass: 45,000ms |
| `AGENT_INVOCATION_MS` | Worker invocation: 55,000ms maximum |
| Function duration | 60s in `vercel.mjs` |
| Session/job claim TTL | 90s; session renewal about every 30s |
| PostgreSQL pool per invocation | Max 4; connection wait 5s, idle timeout 10s, statement timeout 5s, query timeout 6s |

Budgets must be positive integer milliseconds and satisfy `max(pass, API admission) + 6,000 <= invocation <= 55,000`. Increase admission only after measuring database latency. Invocation leaves just 5s below the platform limit; measure entry/bootstrap/teardown overhead.

Pool limits multiply across concurrent Functions. Renewals extend claim expiry, so use persisted expiry timestamps—not time since HTTP request—to assess takeover.

## Vercel and scheduling

Deploy from repository root with Node 24 and the checked-in `vercel.mjs`. The build runs `pnpm build`, serves static chat from `dist/`, and keeps `/api/*` rewrites routed to the existing Function. Neon integration can supply pooled `DATABASE_URL`; retain its recommended SSL settings.

| `AGENT_WORKER_SCHEDULER` | Wake source |
| --- | --- |
| `external` (default) | Hobby-compatible; external scheduler calls deployed `/api/worker` |
| `vercel-cron` | Pro/Enterprise every-minute native cron |

Scheduler selection is build-time; changing it requires redeployment. Both modes use `Authorization: Bearer <CRON_SECRET>`. A later invocation repairs interrupted work; native cron failures are not automatically retried.

For validation, use an isolated database and an authorized provider budget. Preserve Preview Deployment Protection; platform access and application Bearer authentication are separate requirements. Use a bounded independent scheduler, not smoke-client ticks or local `worker:once`, to prove deployed execution. Stop it afterward: minute-by-minute queries prevent Neon idle suspension and consume quota.

The current worker drives one job per tick, scans up to 100 admission/projection rows, and discovers sessions by a full scan. Schema bootstrap runs at request time. These are PoC limits, not throughput or recovery SLOs; see [known gaps](known-gaps.md).

Platform references: [cron authentication/retries](https://vercel.com/docs/cron-jobs/manage-cron-jobs), [cron plan limits](https://vercel.com/docs/cron-jobs/usage-and-pricing), [Function duration](https://vercel.com/docs/functions/configuring-functions/duration).
