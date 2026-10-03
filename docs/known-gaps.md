# Known gaps

## Orphan sessions: legacy crash window closed, internal API risk remains

The old local service committed `pi_poc_sessions` and copied storage before separately inserting ownership. Hard Function termination in between left unreachable sessions: authorization failed closed, so the impact was a storage leak, not cross-tenant exposure.

The current Function service uses `createWithOwner` and `forkWithOwner`. Each commits the session (and fork storage/sequence, when applicable) with `agent_session_access` in one PostgreSQL transaction. Ownership insertion failure rolls back all rows; termination before commit cannot leave a committed ownership-free service session. Termination after commit but before the HTTP response can still leave a fully owned session whose generated id the client did not receive. Fork has no idempotency key; a caller-selected destination id makes a retry return `409`, not the original response.

Native/internal `PostgresSessionRepo.create` and `fork` intentionally retain the ownership-free Pi repository contract. Using them from an application path without atomic ownership can still create sessions invisible to the API. Existing legacy/internal or abandoned sessions are not reconciled automatically. A production sweeper needs an age threshold and explicit exemption/policy for intentional internal sessions, and should use `deletePiPostgresSession` for coordinated cleanup.

## Fork retention and resource limits

There is no fork rate limit, per-principal storage quota, or session/fork retention policy. An authorized caller can repeatedly clone a large tree. Fork reads the source entries/values/lists into memory and copies rows individually in one transaction; large trees can exceed Function time or memory limits. Production needs bounded fork sizes, quotas/rate limiting, and retention/reconciliation scheduling.

## Multiple principals and ownership policy

The HTTP shell uses one configured principal with Bearer-token authentication. It does not implement multi-user token validation, shared sessions, ownership transfer, tenant retirement, or authorization-policy versioning. Source authorization occurs in the service before the fork transaction; dynamic ownership revocation would require a transactional policy/recheck design before supporting multiple principals. Identity headers are never a substitute for that policy.
