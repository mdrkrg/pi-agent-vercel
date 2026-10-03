## Architecture and choices

- TypeScript, Node 24, pnpm 12.8.1, PostgreSQL, and published `@earendil-works/pi-agent-core` / `pi-ai`; dependency versions live in package manifests.
- Pi owns operation, effect, retry, deferred-work, and terminal-result semantics. PostgreSQL persists the native session contract.
- The application owns authorization, recoverable admission, drive scheduling, fenced leases, and rebuildable submission projections.
- Short-lived Functions run bounded drive passes. An independent scheduler resumes work; client connections and process-local objects are not durable authority.
- One configured API principal and one main lane are PoC limits. Sandbox, streaming outbox, and heavy delegated execution are deferred; preserve host-neutral identities and interfaces.

## Read before changing

- [Architecture](docs/architecture.md): responsibility boundaries and durable flow.
- [Durable contract](docs/operation-aware-contract.md): persistence, recovery, and effect guarantees.
- [Decisions](docs/decisions/): contract-first persistence, host boundaries, and fencing.
- [Implementation](docs/runtime-implementation.md): records, admission, worker, result reader, and fork internals.
- [Function reference](docs/function-runtime.md): commands, HTTP contract, configuration, and deployment.
- [Known gaps](docs/known-gaps.md): production limitations and unresolved risks.

## Required invariants

- Import published Pi packages; do not depend on untracked source trees.
- Preserve upstream Pi contracts; do not duplicate its state machine or introduce a second effect ledger. Do not promise exactly-once external effects.
- For leased mutations, validate writer ownership and fencing in the same transaction. Losing ownership or reaching a deadline must close the harness's effect gate, not record a user abort.
- Commit service-facing session creation/forks and user/tenant ownership atomically. Internal ownership-free repository APIs are not service entry points.
- Derive tool principal/context from durable authorized records; identity headers cannot grant authority. Keep unknown and unauthorized reads indistinguishable.
- Recover admission without a client retry. Result polling must not drive execution; earlier results remain frozen after later prompts.
- Reuse native conformance suites; add application tests for SQL atomicity, fencing, authorization, and process recovery rather than reimplementing Pi transition validation.

## Verification and delivery

- Run `pnpm check`, `pnpm test`, and `git diff --check`.
- For SQL verification, use Podman or Docker to start a disposable `postgres:16` container, point `DATABASE_URL` at it, run `pnpm test`, and stop/remove the container afterward.
- Use isolated disposable/test databases. Cloud deployments, provider spending, fault injection, and deletion need explicit authorization; never use a business database for validation.
- Keep credentials and sensitive prompts/results out of logs and Git. Preserve Preview Deployment Protection and use distinct API/worker credentials.
- Independent cloud smoke requires a separate scheduler calling the deployed worker, not driver ticks. Bound requests/time and stop the scheduler after testing; continuous ticks prevent Neon idle suspension.
- Keep API wiring, independent completion, soft deadlines, deployment switches, and hard termination evidence distinct. Report unexecuted checks explicitly.
- Keep commits scoped to one semantic change with related tests. Do not push, deploy, or fabricate verification to satisfy a plan.
- Put stable design in `docs/`, concrete mechanics in the implementation reference, and commands/HTTP/configuration in the Function reference. Avoid version pins, code inventories, test counts, and execution logs in design documents.
- Temporary documents may use `agent_docs`: create it with `mkdir -p agent_docs` and ignore its contents with `echo "*" > agent_docs/.gitignore`.
