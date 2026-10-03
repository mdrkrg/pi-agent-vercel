# Operation-aware durable contract

The runtime preserves Pi's native session contract so committed operations can resume after a worker disappears. It does not define another agent state machine or require exposing Pi's entire API.

## Durable authority

Recovery must determine which operation owns a lane, which conversation/accounting data is committed, and whether an interrupted effect may replay.

| Durable record | Contract |
| --- | --- |
| Conversation entries | Immutable identities and valid parent/branch relationships |
| Values and lists | Atomic state replacement and ordered append/delete semantics |
| Usage | Durable accounting linked to native effects |
| Open operation | Metadata plus a complete resumable current state |
| Terminal result | One immutable result per operation |

Each lane has at most one live operation. Process-local objects and UI events are not authoritative; writer leases are application control state, separate from Pi operation state.

Pi's terminal transaction writes the immutable result, clears the lane's current operation, and deletes open metadata/state plus operation-owned temporary values/lists atomically. Readers must tolerate absent metadata after settlement; later prompts must not change an earlier result's output.

## Atomicity and ownership

- A native session mutation becomes fully visible or has no effect. Entries, usage, branch tips, values/lists, and operation state can share one commit boundary.
- Commit ordering remains monotonic and durable. Concurrent readers cannot observe a partial settlement.
- Every mutation under a lease validates current ownership and fencing in the same transaction. Stale writers cannot publish after takeover.
- Service-facing session creation or fork commits its storage and user/tenant ownership together. Forks follow native copy/exclusion rules and use a coherent source snapshot.
- Admission keeps recoverable input and stable operation identity until schedulable publication. Gaps between native acceptance and application publication are repairable without client resubmission.

## Effects and interruption

Pi owns intent, settlement, retry policy, and terminal cleanup. The adapter persists those records without reproducing their transitions.

| Interrupted work | Native recovery contract |
| --- | --- |
| Assistant request | Settle committed partial under reserved response/usage identities with synthetic zero usage; native retry policy may allow another attempt |
| `safe` tool | May replay with the same invocation identity |
| `never` tool | Must not automatically repeat the effect; record uncertainty through a synthetic error |
| Deferred work | Resume polling the durable provider handle |

Choose `safe` only when repetition is acceptable or the tool implements idempotency. Neither policy guarantees exactly-once external execution. Synthetic zero usage is an accounting marker, not evidence of zero provider billing.

Deadlines, lost ownership, and host shutdown stop new effects and signal admitted work. They do not reverse remote effects or turn infrastructure interruption into a durable user abort.

## Recovery obligations

1. Acquire fenced ownership and reconstruct authorized context from committed records.
2. Inspect native state/result before deciding whether to admit or resume work.
3. Delegate operation/effect recovery to Pi; do not infer state from a queue status or a process-local object.
4. Release ownership during waits and arrange an independent later wake-up.
5. Converge on the same immutable terminal result under repeated drives and repair product projections from it.

Client polling must not drive execution. UI notifications may follow a commit or be replayed from durable data, but cannot become the recovery source of truth.

## Verification gates

Native Storage and SessionRepo conformance are the adapter compatibility gate. Repository-specific tests cover SQL atomicity, fencing, admission gaps, authorized/frozen reads, and fresh-process effect recovery.

Crash tests must identify the interrupted durable boundary, restart independently, and check identity, replay policy, accounting, and terminal-result convergence. Skipped SQL tests are not database evidence; local crash coverage is not cloud hard-termination qualification.

Exhaustive boundary injection, property/model tests, warm/cold load measurements, streaming, and Sandbox qualification are separate later gates. Measure query/transaction latency, connection pressure, queue backlog, and throughput before making scaling or SLO claims.

Concrete records and algorithms belong in [implementation](runtime-implementation.md); routes and budgets belong in the [Function reference](function-runtime.md). Production limitations are listed in [known gaps](known-gaps.md).
