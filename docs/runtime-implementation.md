# Runtime implementation

Current mechanics of the Function PoC; not a second definition of Pi's contract. See [architecture](architecture.md) and the [durable contract](operation-aware-contract.md) for guarantees, and the [Function reference](function-runtime.md) for routes/configuration.

## Records and source map

`StorageBackedSession` supplies native Pi session behavior; the Harness owns operation transitions. The adapter preserves these upstream boundaries:

| Interface | Adapter boundary |
| --- | --- |
| `Storage` | Atomic `commit(writes, context)`, durable reads, ordering, and lease validation |
| `Session` | Native conversation/branch/value behavior through `StorageBackedSession` |
| `SessionMutation` | Exclusive local mutation barrier; zero or one commit attempt, then `end` invalidates/releases the capability |
| `SessionRepo` | Lifecycle, local handle ownership, and native fork policy |

Pi's `MemoryStorage` (backed by `InMemoryStorageState`) and `MemorySessionRepo` are the behavioral references. Native conformance factories define shared behavior across backends; repository tests add SQL, fencing, authorization, and process-recovery cases, not another transition validator.

The PostgreSQL adapter stores operation metadata/state, immutable results, and pending data as namespaced values/lists (`pi.op.meta`, `pi.op.state`, `pi.result`, `pi.pending.*`), alongside entries and usage. There is no application operation/effect table.

| Application record | Responsibility |
| --- | --- |
| `agent_session_access` | User/tenant ownership, atomic with service-facing creation/fork |
| `agent_submissions` | Idempotency identity and rebuildable status/result reference |
| `agent_submission_requests` | Recoverable prompt/lane and reserved Pi operation id |
| `agent_drive_jobs` | Due time, attempts, deferred handles, renewable fenced claims |
| `agent_session_leases` | Exclusive session writer and increasing fencing epoch |

Source entry points:

- [Schema](../packages/pi-postgres/src/schema.ts), [storage](../packages/pi-postgres/src/storage.ts), and [session repository](../packages/pi-postgres/src/session-repo.ts).
- [Admission](../packages/agent-runtime/src/admission.ts), [worker](../packages/agent-runtime/src/function-worker.ts), and [coordinator](../packages/agent-runtime/src/recovery.ts).
- [Ownership guard](../packages/agent-runtime/src/ownership.ts), [result reader](../packages/agent-runtime/src/submission-reader.ts), and [HTTP service](../packages/agent-runtime/src/function-service.ts).

## Admission and publication

1. Commit the submission and recoverable input. The submission id reserves the Pi operation id.
2. Under fenced session ownership, query native metadata/result before calling Pi `accept`; `accept` is not an idempotent lookup.
3. Busy lanes/leases leave input pending for a later worker. Reusing an idempotency key with changed prompt/lane is rejected.
4. In one lease-validated SQL transaction, attach the operation, link/enqueue the job, and delete pending input.

Pi acceptance and application publication are separate transactions. Stored input, stable identity, query-before-accept, and fencing repair that gap. Discovery-created jobs can later be linked to their submission.

## Worker and fencing

`PostgresFunctionWorker.tick` performs four phases:

1. Recover pending admission.
2. Discover native open operations.
3. Claim and run one due drive job.
4. Reconcile unsettled submissions.

Wake-ups carry no principal or operation payload. Harness/tool context is rebuilt from the matching persisted submission, with session ownership rechecked. Result polling never calls the worker.

Normal lifecycle order is **acquire lease → open fenced session/harness → drive → close harness → release lease**. Before release, cleanup awaits harness closure (or session closure if no harness opened) and any in-flight renewal. Cleanup uses a non-aborted context; even a cleanup error still attempts release. Hard process termination can bypass this sequence, leaving takeover to expiry.

Session mutation transactions validate holder, epoch, and expiry while locking the lease row. Release expires rather than deletes that row, so epochs never reset when a holder id is reused.

Both session ownership and job claims renew during a pass. Waiting retry/deferred work releases them; native `notBefore`, provider handles, and poll times determine later scheduling.

Renewal failure, local expiry, parent cancellation, or deadline aborts the observer and closes the harness to seal Pi's effect gate. Cleanup leaves native work recoverable rather than recording a user abort. A remote effect already sent may still complete; hard termination may leave claims until expiry.

## Result reads and projections

The reader authorizes against persisted submission user/tenant, then reads native metadata/state/result in one SQL snapshot. Reads or worker ticks repair product projections; a delayed open snapshot cannot revive a terminal projection.

Terminal metadata/state may be absent. Output is read from immutable `pi.result.tipId`, never the session's latest transcript. Queue `completed` means the drive job finished, not that Pi succeeded; native results can be `failed` or `aborted`. Native `aborted` maps to product `cancelled`.

## Browser conversation client

The Svelte/Vite client uses TanStack Svelte Query for authorized status/result reads, not execution. A browser controller serializes session creation and prompt submission. Before a message request it saves the exact prompt and fresh retry key to tab-local storage; an unconfirmed submission retries with that identity rather than creating another request. Clear/reset invalidates late mutation responses and aborts local HTTP observation, never calling native abort or the worker.

Tab storage is an allowlisted recovery hint, not durable authority: it excludes credentials, assistant outputs, API diagnostics and the Pi state machine. On reload, credentials must be re-entered; native frozen results reconstruct displayed replies. A round unlocks the composer only after its result is read, including failed/aborted results. Later rounds leave earlier result queries unchanged. Responses are rendered as escaped text, and result output extraction excludes thinking/tool blocks.

Query keys contain submission identity and an in-memory credential generation, never the Token. Visibility gates queries; transient read failures keep work observable, while authentication failures clear the in-memory credential. Local request cancellation has no effect on admitted operations. Commands, polling intervals, storage limits and security prerequisites are in the [Function reference](function-runtime.md#live-chat).

## Atomic owner-aware forks

`PostgresSessionRepo.createWithOwner` and `forkWithOwner` are the service entry points. Native `create`/`fork` remain ownership-free internal APIs.

Fork drains already-admitted local source commits, reserves the destination id, and copies under a repeatable-read transaction. That transaction includes source sequence high-water mark and destination ownership; any failure rolls back session, storage, sequence, and owner rows.

The snapshot excludes later commits from another process. Fork does not acquire the source's mutable lease or wait for its active operation to finish.

Both tree and branch forks load all source entries/values/lists into memory before projection, then insert selected rows individually in the same transaction. Branch scope reduces the copied path, not the initial source read; large sources can exceed Function memory/time budgets even for a small branch fork.

- Configured lanes inherit configuration with fresh idle state.
- Operation, pending, result, usage, submission, and job state are not copied.
- Tree scope copies application values/lists; branch scope omits them.
- Native fork projection and ancestry rules remain authoritative.

Source authorization currently precedes the transaction. Dynamic revocation requires a transactional policy design before multi-principal support; see [known gaps](known-gaps.md).

Session cleanup uses `deletePiPostgresSession` in the schema module to coordinate deletion; retention/reconciliation policy remains unimplemented.

## Recovery matrix

These are required repairs, not a claim that every case has been exercised on Vercel.

| Interrupted boundary | Repair |
| --- | --- |
| Input committed before Pi admission | Admit stored prompt without client retry |
| Pi admission before publication | Find reserved identity and publish/link its job |
| Publication before HTTP response | Finish the existing operation without another user entry |
| Pi terminal/job completion before projection | Rebuild status/output from immutable result |
| Assistant effect pending | Native synthetic settlement and captured retry policy |
| Deferred wait persisted | Poll the same durable provider handle |
| Safe tool effect pending | Replay stable invocation identity with reconstructed context |
| Never tool effect pending | Native unknown-outcome error without repeated invocation |

Projection scanning stops between requests on cancellation; remaining work waits for another tick. Native replay/accounting limits are defined in the [durable contract](operation-aware-contract.md).

## Test map

- Native conformance: [Storage](../tests/postgres-storage-contract.test.ts) and [SessionRepo](../tests/postgres-session-repo-contract.test.ts).
- Admission/ownership/results: [admission](../tests/postgres-admission-contract.test.ts), [drive ownership](../tests/postgres-drive-ownership.test.ts), and [results](../tests/postgres-submission-result.test.ts).
- Fresh-process behavior: [SIGKILL boundaries](../tests/postgres-function-crash.test.ts), [tool recovery](../tests/postgres-tool-recovery.test.ts), and [independent local service](../tests/postgres-local-service.test.ts).
- Forks: [HTTP contract](../tests/function-fork-http-contract.test.ts), [atomic ownership](../tests/postgres-owner-fork.test.ts), and [database service](../tests/postgres-function-service.test.ts).
