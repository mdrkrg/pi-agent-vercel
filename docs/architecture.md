# Durable agent PoC architecture

The PoC separates three responsibilities:

- Pi owns conversation and operation semantics.
- The application owns storage placement, authorization, and execution-host selection.
- The scheduler owns retry and resumption of a drive pass.

Postgres is the authoritative store for a resumable session. A process boundary is treated as a normal recovery event, so no correctness decision may depend on process-local Agent state.

The implemented vertical slice uses one main lane, fenced PostgreSQL sessions, durable admission input, a drive queue, and independent Function worker invocations. A local poller or authenticated cron invocation repairs admission, discovers Pi open operations, claims one bounded drive pass, and reconciles submission results. Client connections carry no execution authority.

Pi already implements the effect sandwich: durable intent before an external effect and durable settlement afterward. An interrupted effect has an explicit recovery policy and may have an unknown external outcome. The application does not promise exactly-once effects or introduce another effect state machine.

Sandbox lifecycle, streaming outboxes, and delegated heavy execution are deferred. Existing host/workspace contracts remain available; future hosts must preserve the same session/lane/operation identity, queue, fencing, and Pi result semantics. See [Function runtime](function-runtime.md) for the implemented boundary and operating instructions.

External source trees are inspection-only references. Runtime code imports published packages and never imports from an external source path.
