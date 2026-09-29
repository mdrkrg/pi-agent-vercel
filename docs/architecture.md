# Durable agent PoC architecture

The PoC separates three responsibilities:

- Pi owns conversation and operation semantics.
- The application owns storage placement, authorization, and execution-host selection.
- The scheduler owns retry and resumption of a drive pass.

Postgres is the authoritative store for a resumable session. A process boundary is treated as a normal recovery event, so no correctness decision may depend on process-local Agent state.

The first vertical slice is deliberately smaller than the production architecture: one session, one main lane, deterministic model input, and contract-tested storage. Workflow, streaming, and Sandbox integration follow only after fresh-process recovery is proven.

External source trees are inspection-only references. Runtime code imports published packages and never imports from an external source path.
