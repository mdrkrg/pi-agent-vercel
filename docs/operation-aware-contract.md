# Operation-aware durable contract

This document describes a server-side agent contract that can resume an operation after a worker or host process disappears. It is a design guide for this repository's runtime; it is not a requirement to expose Pi's complete public API.

The contract is the session contract implemented by Pi's `@earendil-works/pi-agent-core` package. The repository adapter must preserve that contract; it must not introduce a second Agent state machine or a competing operation schema.

## Goal and boundary

The contract must answer three questions after every crash:

1. Which operation owns the session and what was its last durable state?
2. Which conversation, usage rows, and application values are already committed?
3. If an external model request or tool may have run, is it safe to retry, settle synthetically, or require an idempotency check?

Postgres is the source of truth. Process-local objects, model streams, UI notifications, caches, and worker leases are recoverable or disposable. A lease fences writers; it is not operation state.

## Repository alignment and implementation status

Operation-state validation and terminal-result immutability belong to Pi's Harness and session runtime. The adapter's responsibility is to implement the `Storage`, `Session`, `SessionMutation`, and `SessionRepo` interfaces with atomic writes, durable reads, ordering, fencing, and the fork rules defined by Pi.

The installed `@earendil-works/pi-agent-core` version is `0.87.1`. Its session contract includes the operation state union listed below, `operationMeta`, `operationState`, `operationResult`, pending values/lists, the one-commit `SessionMutation` capability, and the in-memory reference implementation. The current Postgres code already uses `StorageBackedSession`, so these Pi types and runtime transitions remain the canonical implementation.

The current implementation has the following verified and implemented scope:

- Postgres `Storage` is wired to Pi's storage interface and has 21 registered upstream Storage conformance cases.
- Postgres `SessionRepo` has 17 registered native conformance cases: 7 lifecycle, ownership, and message cases plus 10 fork cases.
- Fresh-process Agent recovery, tool replay policy, leases, and the application submission boundary have focused contract coverage.
- `SessionRepo.fork` is implemented using a repeatable-read source snapshot, source-storage commit draining, destination-id reservation, Pi fork namespace projection, fresh idle lane state, and sequence high-water-mark copying. The 10 fork cases cover branch/tree copying, source closure, fork-point ancestry, reserved state exclusion, destination reservation, and the active-source snapshot boundary.

The repository test command skips SQL-backed suites when `DATABASE_URL` is absent. In the current environment, type checking, static validation, and the non-database suites pass; the 21 Storage and 17 SessionRepo SQL conformance cases require a PostgreSQL-backed run. A CI or developer run with `DATABASE_URL` is required before treating those database cases as verified for the current implementation.

Conceptual operation rows in this document map to Pi's existing namespaced session values (`pi.op.meta`, `pi.op.state`, `pi.result`, `pi.pending.*`) rather than requiring a second operation table. Entries, usage, replaceable values, and append-only lists remain the durable storage primitives. A future design must explain any additional application tables without making them a second source of truth for Pi operation state.

The next implementation phase should start on a new branch. Before additional code changes, review and extend this high-level design with the Pi contract mapping, Postgres schema and transaction boundaries, session/lane lease fencing, fork behavior, crash and recovery matrix, migration/compatibility policy, conformance test matrix, performance measurements, and unresolved decisions. The design must distinguish the native Pi session contract from later application concerns such as submissions, Workflow orchestration, streaming, and Sandbox placement.

## Data model

Keep the durable model small and explicit:

```text
entries       immutable conversation records, linked by parent_id
values        replaceable current state, keyed by namespace and key
lists         append-only bounded progress/frame data, deletable as a whole
usage         append-only model/tool accounting rows
operation     metadata + one complete current state value
result        one immutable terminal result per operation
```

An operation has immutable metadata (`operation_id`, session/lane, kind, starting tip, creation time) and a single replaceable `operation_state`. Every state value is complete and self-sufficient; recovery never infers a checkpoint by looking for a missing row.

The Pi state families used by this contract are:

```text
starting
checkpoint
assistant.ready
assistant.effect_pending
assistant.retry_wait
tools
deferred.suspended
deferred.effect_pending
summary.deciding
summary.ready
summary.effect_pending
summary.retry_wait
navigation.ready_to_commit
```

Tool calls should additionally record `planned`, `effect_pending`, `outcome_ready`, or `completed`, together with a replay policy (`safe` or `never`). Store arguments and reserved result/usage identifiers before invoking an external effect.

## Atomic commit rules

Expose one atomic write primitive:

```ts
commit(writes: Write[], context: Context): Promise<CommitResult>
```

One transaction may insert entries and usage rows, replace values, append/delete lists, update a branch tip, and replace operation state. It must either become fully visible or have no effect. Assign a monotonically increasing commit sequence inside the transaction.

Typical boundaries are:

```text
acceptance:
  user entry + branch tip + operation metadata + operation state

assistant intent:
  operation_state = assistant.effect_pending
  reserved response/usage ids

assistant settlement:
  assistant entry + usage + branch tip
  delete pending frames
  operation_state = tools/checkpoint

tool intent:
  tool status = effect_pending
  arguments and replay policy

tool settlement:
  tool result entry + branch tip
  delete pending result
  operation_state = checkpoint/tools

terminal:
  delete operation-owned temporary values/lists
  write immutable result
  clear lane current operation
```

Do not make the UI event stream authoritative. Publish UI events after commit, or let clients replay committed entries and progress lists after reconnect.

## Recovery algorithm

Recovery must be deterministic and idempotent:

1. Acquire the session/lane lease and verify its epoch on every mutation transaction.
2. Read lane state and `operation_state`.
3. If no current operation exists, return idle.
4. Dispatch by the state discriminator.
5. For `effect_pending`, apply the recorded replay policy: `safe` retries using the stable invocation id; `never` queries an idempotency/result store or settles as unknown according to product policy. Provider requests must preserve reserved usage ids and record settled or synthetic usage.
6. Continue until the operation reaches one terminal transaction.
7. A repeated drive of the same operation must return the same terminal result, not create a second result entry.

External tools must receive a stable invocation identity and must either be idempotent or provide a durable effect/result lookup. Exactly-once execution cannot be provided by the database transaction alone.

## Implementation sequence

### 1. Freeze and map the Pi contract

Import the operation metadata/state, writes, terminal results, replay policy, mutation capability, and fork types from Pi. Document how each Pi value namespace is persisted by Postgres. Add adapter-boundary checks only where they protect the Pi interface or database representation; do not duplicate Harness state transitions.

### 2. Use Pi's in-memory implementation as the reference

Run the same contract suite against Pi's in-memory implementation and Postgres. Use Pi's `InMemoryStorageState` and session conformance helpers as the behavioral reference. Add repository-specific tests only for SQL transactions, fencing, process recovery, and operational limits.

### 3. Complete Postgres persistence

Use tables scoped by `session_id` and `operation_id`. Add unique keys for immutable ids, an index on `(session_id, seq)`, and row-level fencing for the lease. Keep the transaction that validates the lease and writes the state in one database transaction.

`SessionRepo.fork` follows Pi's fork policy: branch and tree copies exclude active operation/result/pending state as specified, reserve destination identity safely, and use a coherent source snapshot while the source is concurrently changing. Further native-contract work should continue from a new branch after this design is reviewed.

### 4. Add the drive adapter

Separate `accept` from `drive`. `accept` creates durable intent; a worker may perform `drive` later. A drive pass should be short and restartable, returning `completed`, `waiting`, `retry_at`, or `failed` rather than holding a process lease across a provider wait.

### 5. Add projections only after correctness

Maintain branch tips, message counts, and usage totals as rebuildable projections. They may accelerate reads but must not be required to recover operation state.

Application submission state is outside this native session contract. The current submission flow still has a process crash window between Pi admission and attaching the operation id; resolve that in a separate application-boundary design after the Postgres SessionRepo contract is complete.

## Test plan

### Contract and transaction tests

Run the same suite against the in-memory and Postgres implementations. Verify atomic visibility, rollback on validation failure, duplicate-id rejection, parent/tip invariants, value replacement, list append/delete, monotonic commit sequences, lease fencing, and idempotent terminal cleanup.

### State-machine tests

For every state, test legal successor states and reject illegal transitions. Include assistant retries, tool batches, deferred work, compaction, navigation, abort, and terminal failure. Assert that each persisted state contains enough information to resume without process-local variables.

### Crash-injection matrix

Inject a process failure immediately before and after every durable boundary: acceptance; assistant intent; provider streaming; provider response before settlement; tool intent; tool side effect before settlement; retry scheduling; and terminal cleanup. Restart in a fresh process, acquire a new lease, drive the same operation, and assert no duplicate entry/result, the documented replay policy, preserved or synthetic usage, converged tip/state, and no repeated `never` effect.

### Property and model tests

Generate sequences of prompts, tool outcomes, aborts, retries, crashes, and duplicate drive requests. Compare Postgres with the in-memory reference after every restart. Invariants include one live operation per lane, one terminal result per operation, and no entry whose parent is absent.

### Concurrency and lease tests

Run many sessions and two workers racing on one session. Verify that only the lease holder can commit, stale epochs fail, duplicate admissions converge on one operation, and unrelated sessions progress concurrently. Measure connections, transaction latency, lock waits, read/write counts, and backend CPU.

### Recovery and load scenarios

Benchmark separately: warm worker with an in-memory context; cold worker rebuilding from Postgres; repeated crash/restart at each boundary; long append-only histories; tool-heavy turns and bounded progress updates; and 100–200 independent sessions with a controlled connection pool.

Report SQL by phase (`accept`, `drive`, `recovery`, `settlement`, `teardown`), transaction p50/p95/p99, query counts, rows/bytes, pool saturation, lock waits, and CPU. Run a separate test with realistic provider latency.

## Exit criteria

The contract is ready for service integration when the in-memory and Postgres suites agree, all crash points have an explicit expected outcome, stale leases cannot publish state, duplicate drives are idempotent, and warm/cold load results identify the expected database bottleneck. Only then should workflow orchestration, streaming APIs, and sandbox hosts be added.
