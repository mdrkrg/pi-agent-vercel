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
| `AGENT_PASS_MS` | Drive pass: 45,000ms |
| `AGENT_INVOCATION_MS` | Worker invocation: 55,000ms maximum |
| Function duration | 60s in `vercel.mjs` |
| Session/job claim TTL | 90s; session renewal about every 30s |
| PostgreSQL pool per invocation | Max 4; connection wait 5s, idle timeout 10s, statement timeout 5s, query timeout 6s |

Budgets must be positive integer milliseconds and satisfy `max(pass, API admission) + 6,000 <= invocation <= 55,000`. Increase admission only after measuring database latency. Invocation leaves just 5s below the platform limit; measure entry/bootstrap/teardown overhead.

Pool limits multiply across concurrent Functions. Renewals extend claim expiry, so use persisted expiry timestamps—not time since HTTP request—to assess takeover.

## Tracing

The Node Function explicitly initializes `@vercel/otel` once per module lifetime on Vercel. It is not a Next.js instrumentation hook. Application spans use the standard OpenTelemetry API; tracing does not change admission, Pi recovery, scheduling, or lease authority.

| Setting | Behavior |
| --- | --- |
| `OTEL_SDK_DISABLED=true` | Disable SDK initialization; application spans become no-ops without another installed provider |
| `OTEL_SERVICE_NAME` | Override the default `pi-agent-vercel` service name |
| `OTEL_TRACES_SAMPLER`, `OTEL_TRACES_SAMPLER_ARG` | Configure SDK sampling; Vercel can apply additional sampling |
| `OTEL_EXPORTER_OTLP_ENDPOINT` or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | Explicit collector endpoint; also enables SDK initialization in local service/worker entry points |
| `OTEL_EXPORTER_OTLP_PROTOCOL`, `OTEL_EXPORTER_OTLP_HEADERS` | SDK collector protocol/authentication; keep export credentials server-side |

Ordinary local execution has no SDK exporter. Installing the SDK does not configure a Vercel destination: use [Session Tracing](https://vercel.com/docs/tracing/session-tracing) for browser-originated diagnostics, or configure [Trace Drains](https://vercel.com/docs/drains/reference/traces) for independent worker invocations and verify collection in the selected backend. A browser session does not automatically trace a separate cron request. Preserve Preview Protection and worker authentication when collecting traces.

For a slow worker, inspect `function.configure` → `function.handle` / `database.ready` → `worker.tick`, then compare `worker.admission.recover`, `worker.discover`, `worker.run`, and `worker.reconcile`. Expand `job.pass` for claim-adjacent execution, authorization, session/harness loading, `job.drive`, settlement, and ownership cleanup. `function.close` measures repository/pool teardown. Platform cold-start/module-loading time precedes these application spans; use Vercel infrastructure spans for that portion.

`submission.admit` records the durable submission ID after request creation; `job.pass` exports job/operation/submission correlation IDs, attempt count, status, job age, and lateness since `availableAt`. These let submission and multiple worker requests be correlated without storing trace context in Pi state. Lateness is not a first-claim timestamp or pure scheduler wait: it can include backlog, initialization, discovery, and recovery delays. The scheduler interval and time before the Function starts remain outside invocation duration.

Application instrumentation exports route templates, not resource paths or query strings. It excludes prompts, replies, user/tenant identities, authentication headers, SQL text/parameters, and exception messages/stacks. Automatic SDK fetch instrumentation is deliberately disabled to avoid raw URL/error capture; `job.drive` includes model/tool wall-clock time but does not split first-token/network timing or individual SQL queries. Vercel infrastructure telemetry is configured separately. Trace metadata and correlation IDs still require appropriate backend access and retention policies.

The SDK integrates with Vercel's request lifecycle for export; do not shut it down after each invocation. Hard termination can lose unexported/unfinished spans. Missing traces or spans are not evidence that durable work was never admitted or executed. Local in-memory tests do not qualify cloud export, sampling, tracing overhead, or hard-termination delivery.

See [implementation](runtime-implementation.md#tracing-mechanics) for span nesting and [Vercel instrumentation](https://vercel.com/docs/tracing/instrumentation) for destination setup.

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
