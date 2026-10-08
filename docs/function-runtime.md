# Function reference

HTTP contract and deployment settings for the single-principal Function PoC. See [Development](development.md) for local commands and chat usage, [architecture](architecture.md) for design, and [implementation](runtime-implementation.md) for persistence/recovery mechanics.

## Authentication and routes

API requests use `Authorization: Bearer <APP_API_TOKEN>`; worker requests use a distinct `CRON_SECRET`. Ownership checks require both **userId AND tenantId** to match the configured principal. Identity headers are ignored; unknown and unauthorized resources return the same `404`.

When upgrading, rename environment settings to match [.env.example](../.env.example). Keep existing values. Old names are not supported.

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

`AGENT_FAUX_RESPONSE` selects an isolated deterministic provider; omit it for real execution. The environment entry configures no tools; programmatic `FunctionService` options can supply them.

Credentials stay server-side. This entry does not load coding-agent `auth.json`, `models.json`, or extensions, or configure persistent OAuth refresh. Provider bundle size and cold-start behavior need deployment measurement.

## Budgets and connections

| Setting | Default / constraint |
| --- | --- |
| `AGENT_ADMISSION_MS` | API admission ownership: 10,000ms; worker recovery remains 10,000ms |
| `AGENT_PASS_MS` | Drive pass: 270,000ms |
| `AGENT_INVOCATION_MS` | Worker invocation: 285,000ms default and maximum |
| Function duration | 300s in `vercel.mjs`, with Fluid compute enabled |
| Session/job claim TTL | 90s; session renewal about every 30s |
| PostgreSQL pool per invocation | Max 4; connection wait 5s, idle timeout 10s, statement timeout 5s, query timeout 6s |
| External scheduler transport | HTTP timeout 310s, CLI process timeout 330s. Next request 60s after completion |

Budgets must be positive safe integer milliseconds and satisfy `max(pass, API admission) + 6,000 <= invocation <= 285,000`. Defaults reserve 15s at both deadline boundaries. Measure entry/bootstrap/teardown overhead and database latency before adjusting budgets.

Pool limits multiply across concurrent Functions. Renewals extend claim expiry, so use persisted expiry timestamps—not time since HTTP request—to assess takeover.

## Vercel and scheduling

Deploy from repository root with Node 24 and the checked-in `vercel.mjs`. The build runs `pnpm build`, serves static chat from `dist/`, and keeps `/api/*` rewrites routed to the existing Function. Neon integration can supply pooled `DATABASE_URL`; retain its recommended SSL settings.

| `AGENT_WORKER_SCHEDULER` | Wake source |
| --- | --- |
| `external` (default) | Hobby-compatible; external scheduler calls deployed `/api/worker` |
| `vercel-cron` | Pro/Enterprise every-minute native cron |

Scheduler selection is build-time; changing it requires redeployment. Both modes use `Authorization: Bearer <CRON_SECRET>`. A later invocation repairs interrupted work; native cron failures are not automatically retried.

For foreground scheduling during development, use the [external worker command](development.md#deployed-worker).

For validation, use an isolated database and an authorized provider budget. Preserve Preview Deployment Protection; platform access and application Bearer authentication are separate requirements. Use a bounded independent scheduler, not smoke-client ticks or local `worker:once`, to prove deployed execution. Stop it afterward: minute-by-minute queries prevent Neon idle suspension and consume quota.

The current worker drives one job per tick, scans up to 100 admission/projection rows, and discovers sessions by a full scan. Schema bootstrap runs at request time. These are PoC limits, not throughput or recovery SLOs; see [known gaps](known-gaps.md).

Platform references: [cron authentication/retries](https://vercel.com/docs/cron-jobs/manage-cron-jobs), [cron plan limits](https://vercel.com/docs/cron-jobs/usage-and-pricing), [Function duration](https://vercel.com/docs/functions/configuring-functions/duration).
