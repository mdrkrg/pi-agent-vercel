# Durable agent architecture

The runtime separates agent semantics, durable persistence, and execution scheduling so that a worker process can disappear without losing committed work.

## Responsibilities

| Component | Owns | Does not own |
| --- | --- | --- |
| Pi | Conversation, operations, effects, retries, deferred work, terminal results | Application authentication or execution placement |
| PostgreSQL adapter | Atomic persistence of Pi's native session contract | A second agent state machine |
| Application | Authorization, recoverable admission, fenced ownership, submission projections | Pi operation transitions or external-effect outcomes |
| Scheduler / execution host | Wake-ups and bounded drive passes | Durable truth or client-session lifetime |

PostgreSQL is authoritative. In-memory agents, streams, caches, and client connections can be reconstructed or discarded. A lease authorizes a writer; it is not operation state.

## Durable flow

1. Authorize and persist a request with enough input to recover admission.
2. Under fenced ownership, establish its Pi operation and publish schedulable work.
3. An independent wake-up rebuilds context and runs a bounded drive pass.
4. Waiting work releases ownership; a later pass resumes from committed state.
5. Clients read the immutable Pi result. Application status is a rebuildable projection.

Admission and scheduling may have separate commit boundaries; stable identity and reconciliation must repair their gap without requiring a client retry.

## Effect and host boundaries

Pi records intent before an external effect and settlement afterward. Interruption can leave the external outcome unknown. Fencing prevents stale database writes, not remote effects; exactly-once execution is not promised.

Function, workflow scheduler, and optional Sandbox have different placement roles, not different agent semantics. Any future host must preserve session/lane/operation identity, authorization, fencing, and native results.

The current scope is one configured principal and one main lane. Sandbox lifecycle, streaming outbox, and heavy delegated execution are deferred.

## Further reading

- [Durable contract](operation-aware-contract.md): atomicity, recovery, and replay guarantees.
- [Decisions](decisions/): rationale for contract-first persistence, host boundaries, and fencing.
- [Implementation](runtime-implementation.md): current records and algorithms.
- [Function reference](function-runtime.md) and [known gaps](known-gaps.md): usage and operational limits.
