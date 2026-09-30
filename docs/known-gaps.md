# Known gaps

Accepted PoC gaps that are not covered by the contract suite. Each gap records the trigger, the observable impact, why it is accepted for the PoC, and the production fix. This document replaces roadmap-style tracking; it lists defects, not plans.

## GAP-001: session row and ownership row are committed in separate transactions

**Location**: `apps/vercel-service/src/service.ts` (`createSession`, `forkSession`) and `packages/pi-postgres/src/session-repo.ts` (`copyFork`).

**Trigger**: hard process death (Function kill, timeout, OOM) after the session/storage transaction commits and before `INSERT INTO agent_service_session_access` runs.

**Impact**: an orphan session — `pi_poc_sessions` and its storage rows exist, but no `agent_service_session_access` row does. `authorizeSession` reads only the access table and returns 404, so the orphan is unreachable through every API route. The effect is a storage leak, not a correctness or authorization defect: the system fails closed. There is no cross-tenant exposure and no partially visible session.

**Why accepted for the PoC**:
- The residual window requires hard process death. Ordinary errors on the fork path are already compensated.
- No API route reaches a session without an access row, so the orphan cannot be read, driven, or forked.
- Closing it correctly means either moving application authorization into the storage commit path or adding a GC job; both exceed the current slice.

**Production fix** (either one closes the class, the first is preferred for this codebase):
1. **Orphan reconciliation** — sweep `pi_poc_sessions` for ids with no `agent_service_session_access` row above an age threshold and call `deletePiPostgresSession`, which already cascades every dependent table. Needs a retention threshold and a scheduler hook (cold start or cron). This is reusable regardless of GAP-001, because production also needs GC for abandoned sessions and retired tenants.
2. **Atomic commit** — add a repository method that runs replication and the ownership insert in one transaction, e.g. by handing the commit path an `inTransaction(transaction)` callback. Apply it to `create` and `fork` together. Trade-off: it couples the storage commit to application authorization and adds a callback that must preserve lock order.

**Non-crash window**: already closed. `createSession` and `forkSession` both compensate a failed ownership insert by closing the session and deleting it, so the residual window is hard process death only.
