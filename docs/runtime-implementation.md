# Runtime implementation

Pi runs the agent, with PostgreSQL for durability and the application for authorization and scheduling. See [architecture](architecture.md), the [durable contract](operation-aware-contract.md), and the [Function reference](function-runtime.md).

## Records and source map

- **Native state:** conversation, usage, operations and results stay in Pi's storage contract. There is no second application effect ledger.
- **Access** (`agent_session_access`): user/tenant ownership, committed with session creation or fork.
- **Submissions** (`agent_submissions`): request identity and rebuildable status/result references.
- **Pending requests** (`agent_submission_requests`): saved input and reserved operation identity for admission recovery.
- **Drive jobs** (`agent_drive_jobs`): when work should run and who currently claims it.
- **Session leases** (`agent_session_leases`): the active writer and its fencing epoch.

Start reading the code here:

- [Schema](../packages/pi-postgres/src/schema.ts), [storage](../packages/pi-postgres/src/storage.ts), and [session repository](../packages/pi-postgres/src/session-repo.ts).
- [Admission](../packages/agent-runtime/src/admission.ts), [worker](../packages/agent-runtime/src/function-worker.ts), and [coordinator](../packages/agent-runtime/src/recovery.ts).
- [Ownership guard](../packages/agent-runtime/src/ownership.ts), [result reader](../packages/agent-runtime/src/submission-reader.ts), and [HTTP service](../packages/agent-runtime/src/function-service.ts).

## Admission and publication

- **Save first:** persist the submission and input. The submission id also reserves the Pi operation id.
- **Check before accepting:** under a fenced lease, look for an existing native operation/result. Calling Pi `accept` again is not an idempotent lookup.
- **Wait safely:** a busy lane leaves input pending. Reusing a request key with different input is rejected.
- **Publish atomically:** attach the operation, enqueue/link its job and remove pending input in one lease-validated transaction.
- Acceptance and publication are separate commits. Saved input and stable identity let the worker repair interruptions without a client retry.

## Worker and fencing

- **Each tick:** recover admissions → discover open operations → run one due job → reconcile submissions.
- **Authority comes from storage:** rebuild principal/tool context from the authorized submission, not the wake-up payload. Result polling never runs the worker.
- **Writer lifecycle:** acquire lease → open harness → drive → close harness → release lease. Await closure and in-flight renewal before release. Attempt release even if cleanup fails.
- **Fence every write:** lock the lease row and validate holder, epoch and expiry in the mutation transaction. Release expires the row rather than resetting its epoch.
- **Renew while running:** session leases and job claims renew during a pass. Waiting work releases them for later scheduling.
- **Stop effects, not the operation:** ownership loss or a deadline closes the harness effect gate without recording a user abort.
- **External effects remain uncertain:** already-sent effects may still finish. Fencing does not promise exactly-once execution.
- **Failure diagnostics:** unexpected HTTP failures log only stage, fixed error category/type and elapsed time. Raw exceptions, SQL, credentials and conversation data are omitted.
- Hard termination can bypass cleanup. Recovery waits for outstanding claims to expire, then delegates effect replay and deferred polling to Pi.

## Tracing mechanics

- **Request parent:** [tracing](../packages/agent-runtime/src/tracing.ts) accepts W3C context, otherwise uses the active host span or Vercel SDK root. Baggage and identity headers are not imported or used for authorization.
- **Privacy and failure isolation:** [bootstrap](../packages/agent-runtime/src/telemetry-bootstrap.ts) installs an attribute allowlist before automatic SDK exporters, removing SDK-enriched request headers, events and status messages. Span/context setup failures fall back to execution without retrying the callback; telemetry never replaces execution/cleanup errors or durable authority.
- **Measured phases:** configuration/database preparation/handling/cleanup; worker admission recovery/discovery/job passes/reconciliation; ownership acquisition/renewal/closure/release. Durable IDs correlate admissions and passes. Ticks retain completed-stage counts and failure phase; deadline signaling precedes annotations. Job lateness uses current `availableAt`, age uses `createdAt`, not historical claim timing.
- **Limits:** discovery emits spans per visited session. Sampling and span volume require measurement; individual SQL and provider first-token latency are not measured. There is no trace outbox. Collection settings and local flush behavior are in the [Function reference](function-runtime.md#tracing).

## Result reads and projections

- **Authorize first:** check persisted user/tenant ownership and read native state/result in one SQL snapshot.
- **Keep old replies fixed:** read output from the immutable result's `tipId`, not the latest conversation tip. Terminal metadata may already be gone.
- **Repair status:** reads and worker ticks rebuild projections. Stale reads cannot reopen a terminal submission.
- **Job completion is not success:** use Pi's terminal result. Native `aborted` is exposed as `cancelled`.

## Browser conversation client

- **Observe, don't execute:** the browser submits sequential turns and polls durable results. It never calls the worker.
- **Retry the same request:** save the prompt and retry identity before sending, so an uncertain response does not require a duplicate submission.
- **Local recovery only:** tab storage keeps drafts, prompts and recovery IDs, not credentials or assistant output. Replies are re-read and rendered as escaped text.
- **Keep server work independent:** clearing local history or cancelling a browser request does not cancel admitted work.
- Local setup and usage are in [Development](development.md#chat-ui).

## Atomic owner-aware forks

- **Service entry points:** `createWithOwner` / `forkWithOwner` include ownership. Native `create` / `fork` remain ownership-free internal APIs.
- **One snapshot, one commit:** drain local writes, reserve the destination, then copy storage, sequence state and ownership in a repeatable-read transaction. Failure rolls everything back.
- **No source pause:** the snapshot excludes later writes from other processes. Forking does not wait for an active source operation to finish.
- **Fresh execution state:** lanes start idle. Operations, pending work, results, usage, submissions and jobs are not copied.
- **Application data:** tree forks copy application values/lists. Branch forks omit them.
- **Size limit:** both scopes load the whole source into memory and insert rows individually. Large forks can exceed Function budgets.
- **Authorization gap:** source authorization precedes the transaction. Dynamic revocation is not yet supported. See [known gaps](known-gaps.md).
- **Deletion:** `deletePiPostgresSession` coordinates cleanup. Retention policy remains unimplemented.

## Test map

- Native conformance: [Storage](../tests/postgres-storage-contract.test.ts) and [SessionRepo](../tests/postgres-session-repo-contract.test.ts).
- Admission/ownership/results: [admission](../tests/postgres-admission-contract.test.ts), [drive ownership](../tests/postgres-drive-ownership.test.ts), and [results](../tests/postgres-submission-result.test.ts).
- Fresh-process behavior: [SIGKILL boundaries](../tests/postgres-function-crash.test.ts), [tool recovery](../tests/postgres-tool-recovery.test.ts), and [independent local service](../tests/postgres-local-service.test.ts).
- Forks: [HTTP contract](../tests/function-fork-http-contract.test.ts), [atomic ownership](../tests/postgres-owner-fork.test.ts), and [database service](../tests/postgres-function-service.test.ts).
- Tracing: [async context](../tests/tracing-contract.test.ts), [real SDK/privacy/export](../tests/telemetry-sdk-contract.test.ts), [cleanup failure isolation](../tests/ownership-tracing-contract.test.ts), [worker deadlines](../tests/worker-tracing-contract.test.ts), and [database-backed spans](../tests/postgres-function-tracing.test.ts).

Local recovery tests are not Vercel hard-termination qualification. Native replay guarantees belong to the [durable contract](operation-aware-contract.md).
