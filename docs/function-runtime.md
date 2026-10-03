# Function durable runtime

This design defines a Function-based durable agent runtime: PostgreSQL persistence, the published Pi `0.87.1` contract, one main lane, a single-principal API, and disposable worker processes. Sandbox is deferred while host interfaces and durable identities remain compatible.

## Ownership and durable records

Pi owns `pi.op.meta`, `pi.op.state`, `pi.result`, pending frames, entries, usage, and lane transitions. Application records have narrower responsibilities:

| Record | Responsibility |
| --- | --- |
| `agent_session_access` | Session user/tenant ownership, inserted atomically with session creation or service-facing fork |
| `agent_submissions` | Request identity and rebuildable product status/result reference |
| `agent_submission_requests` | Pending prompt/lane and reserved Pi operation id until publication |
| `agent_drive_jobs` | Scheduling, attempts, retry/poll time, job claims and fencing |
| `agent_session_leases` | Exclusive mutable session ownership and increasing fencing epochs |

Admission first commits a submission and its recoverable input. Its reserved operation id is the submission id. Under fenced session ownership, recovery queries Pi metadata/result before considering `accept`; Pi `accept` itself is not an idempotent lookup. Busy lanes and busy leases leave the input accepted for later recovery. Publication attaches the operation id, links/enqueues the job, and deletes pending input in one lease-validated SQL transaction. Prompt/lane mismatches on a client idempotency key are rejected.

The Pi admission transaction and application publication transaction remain separate. Persisted input, stable identity, query-before-accept, and fencing make their crash gap repairable without a client retry. Discovery-created jobs can subsequently be linked to their submission.

## Independent execution and time budgets

`PostgresFunctionWorker.tick` repairs pending admission, discovers Pi open operations, claims one due drive job, and reconciles unsettled submissions. A wake-up contains no principal or operation payload. The harness factory rebuilds tool context from the persisted submission and rechecks session ownership. Polling a result never drives the agent.

The local runner polls independently of HTTP connections. Vercel uses authenticated `/api/worker` cron calls; a subsequent tick repairs an interrupted previous invocation. Waiting retry/deferred operations release session ownership and job claims. Pi's `notBefore` determines retry time; deferred handles and poll times remain durable.

Default budgets are a 45-second drive pass, 55-second worker invocation, and a 60-second Function limit. Database query timeouts and cleanup headroom bound ordinary teardown. Both session and job claims renew during a pass. Renewal failure, parent cancellation, local lease expiry, or a deadline aborts the observer and closes Pi's harness, sealing its effect gate. Host shutdown leaves native durable state open for recovery rather than issuing a user abort.

An already-sent remote effect may still complete despite cancellation. Hard Function termination can interrupt cleanup; expired claims and a fresh invocation repair this case. Fencing protects database writes and does not roll back remote effects.

## Pi effect sandwich

There is no exactly-once promise and no parallel application effect ledger.

| Native state/policy | Fresh-worker behavior |
| --- | --- |
| Assistant `effect_pending` | Settle committed partial under reserved response/usage ids, with synthetic zero usage; captured Pi retry policy may start a new attempt later |
| Tool `safe` | Replay using the same invocation id; the tool must make repeat execution acceptable |
| Tool `never` | Do not invoke the interrupted effect again; synthesize an error indicating unknown external outcome |
| Deferred wait | Reconstruct and poll the committed provider handle |

Zero synthetic usage does not establish actual provider billing. Product-specific reconciliation, idempotency keys, or compensation remain tool adapter choices when required.

## Authoritative reads

Status reads authorize by persisted submission user/tenant and read Pi metadata/state/result in one SQL snapshot. Product projections can lag, fail, and be repaired by a read or worker tick. A delayed open snapshot cannot revive a terminal projection.

Pi deletes operation metadata/state upon settlement. The result reader uses the immutable `pi.result` and its frozen `tipId`; later prompts cannot change an earlier operation's output. Queue `completed` means the drive job finished: the Pi result may still be `failed` or `aborted`. Pi `aborted` maps to product `cancelled`.

## HTTP and configuration

| Route | Authentication | Response |
| --- | --- | --- |
| `POST /api/sessions` | `POC_API_TOKEN` | Owned session, `201` |
| `POST /api/sessions/:id/fork` | API token, source session ownership | Atomically owned fork, `201` |
| `POST /api/sessions/:id/messages` | API token, session ownership, `Idempotency-Key` | Durable submission, `202` |
| `GET /api/submissions/:id` | API token, submission ownership | Pi status/result projection |
| `GET /api/submissions/:id/result` | API token, submission ownership | Frozen result/output; `409` before completion |
| `GET` or `POST /api/worker` | `CRON_SECRET` | One independent worker tick |

Both tokens use `Authorization: Bearer ...`. User/tenant come from configuration and persisted records; development identity headers are ignored. This shell supports one configured principal. Multi-user token validation and authorization-policy versions are future application work. The runtime accepts tools via `FunctionService` options; the environment entry starts with no tools configured.

### Session forks

`POST /api/sessions/:id/fork` accepts a JSON object. `scope` is required:

- `{"scope":"tree"}` copies the whole conversation tree and branch tips. Optional `id` selects the destination; `branch`, `entryId`, and `position` are rejected for tree scope.
- `{"scope":"branch","branch":"main","entryId":"entry-1","position":"before"}` copies one configured AgentLane path. `branch` is required; `entryId` defaults to its current tip. `position` is `at` (default, includes the entry) or `before` (stops at its parent). The entry must be on the current tip ancestry.
- Supplied `id`, `branch`, and `entryId` must be non-empty strings. Unknown scope, invalid fields, unknown/data-only source branch, or an off-branch/unknown entry return `400`.

The source must belong to the configured user **and** tenant; missing or unauthorized sources return the same `404`, before body validation. Identity headers cannot override this principal. Success returns `201` with `{"session": <metadata>}` including `parentSessionId`. An existing destination id returns `409` without modifying it; fork is not an idempotent API.

`PostgresSessionRepo.forkWithOwner` drains already-admitted local source storage commits, then copies entries, projected values/lists, and the source sequence high-water mark under one repeatable-read transaction. That transaction also inserts `agent_session_access`. Ownership failure rolls everything back; process death cannot commit session/storage without ownership. Another process's source changes after the snapshot are not included; fork does not acquire a mutable source lease or wait for an active operation to finish.

Configured lanes inherit configuration with fresh idle state. Operation/pending/result/usage state and application submission/job records are not copied. Tree scope copies application values/lists; branch scope omits them. The fork owner may submit fresh messages, and other users/tenants cannot access or fork it. The native `SessionRepo.fork` remains an ownership-free internal API, not an HTTP path.

Fork retention/reconciliation, rate limits/quotas, and multi-principal policy are not implemented. See [known gaps](known-gaps.md).

Provider/model identity and credentials belong to server configuration rather than wake-up payloads. The selected model must be available in the worker's Pi catalog. Execution budgets must preserve at least six seconds of cleanup headroom and fit the configured Function limit. Local polling and platform cron are interchangeable wake sources over the same durable worker contract.

`vercel.mjs` selects the worker wake-up source at build time. `AGENT_WORKER_SCHEDULER=external` omits the native cron for Hobby deployments; an external scheduler calls `/api/worker`. `AGENT_WORKER_SCHEDULER=vercel-cron` adds the once-per-minute native cron for Pro or Enterprise. Both modes use the same `CRON_SECRET` Bearer authentication and durable worker contract. Cron failures are not automatically retried, so recovery depends on a later invocation. See [cron authentication and retries](https://vercel.com/docs/cron-jobs/manage-cron-jobs), [cron plan limits](https://vercel.com/docs/cron-jobs/usage-and-pricing), and [Function duration](https://vercel.com/docs/functions/configuring-functions/duration).

## Recovery boundaries

Recovery must work from committed records after ownership expires, without a client retry or a caller remembering the operation id:

| Interrupted boundary | Required repair |
| --- | --- |
| Input committed before Pi admission | Admit stored prompt once without client retry |
| Pi admission before publication | Find reserved Pi identity and publish its job |
| Publication before client response | Complete existing job without duplicate user entry |
| Pi terminal/job completion before projection | Rebuild submission from immutable result |
| Assistant effect pending | Synthetic response/usage, durable retry, later fresh-process attempt |
| Deferred wait persisted | Fresh process polls the same provider handle |
| Safe tool effect pending | Replay with stable invocation id and reconstructed principal |
| Never tool effect pending | No repeated invocation; durable unknown-outcome tool error |

Projection scanning must stop between requests when its invocation is cancelled and leave remaining projections for a later tick. Client connection lifetime must not control worker execution or recovery.

## Scope and scaling

The PoC permits full-session discovery, admission/projection scans of up to 100 rows, and one drive job per tick. Scaling requires indexed recovery selection, controlled migrations instead of request-time schema bootstrap, and explicit queue fairness and connection limits.

Streaming outbox/replay, real Sandbox lifecycle, artifact/workspace persistence, delegated heavy jobs, and retention remain deferred. Future execution hosts must use the same admission, queue, fencing, authorization, and Pi result contracts.
