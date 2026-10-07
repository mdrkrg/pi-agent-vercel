# Known gaps

The Function PoC is not production-qualified. These limits remain even when local contracts and a small deployed smoke pass.

## Authentication and ownership policy

- The HTTP shell supports one configured principal, not multi-user token validation, shared sessions, ownership transfer, or tenant retirement.
- The browser chat requires a trusted operator to enter that principal's API token. It is not a public authentication system or a server-side credential proxy. Prompt/retry records in tab storage are plaintext; browser-local recovery can be lost through storage failure or tab closure.
- Source authorization precedes the fork transaction. Dynamic revocation needs a transactional policy/recheck design; identity headers cannot substitute for it.

## Session cleanup and fork limits

- Service-facing creation/fork now commits ownership atomically, closing the old ownership-free crash window. Internal ownership-free APIs can still create sessions invisible to the HTTP shell.
- For ownership-free orphans, HTTP authorization fails closed: the impact is unreachable/leaked storage, not cross-tenant API exposure.
- A commit followed by a lost HTTP response can leave an owned session whose generated id the client never received. Fork has no idempotency key; retrying a caller-selected destination returns `409`, not the original response.
- Legacy, internal, and abandoned sessions are not reconciled automatically. Cleanup needs age thresholds, internal-session exemptions, and coordinated deletion—not a blanket delete of sessions without an owner.
- Fork size, rate, storage quota, and retention are unbounded. Even branch forks load the full source before projection and copy selected rows individually; large sources can exceed Function memory/time limits. Add bounds before admitting untrusted callers or large histories.

Atomic copy and cleanup mechanics are described in [implementation](runtime-implementation.md).

## Recovery and scaling

- Full-session discovery, bounded admission/projection scans, and one job per tick do not establish queue fairness or throughput.
- Request-time schema bootstrap needs controlled migrations before shared-deployment/schema rollout complexity grows.
- Per-invocation connection pools do not enforce a global database connection limit. Measure latency, contention, claim expiry, and backlog before selecting production budgets or SLOs.
- A small cloud smoke does not qualify second-principal authorization, deliberate deadlines, deployment-switch recovery, hard termination/takeover, tool recovery, or load behavior. Each requires separate evidence.

## Deferred product capabilities

The browser chat provides polling-based text conversation, not token streaming, tool traces, Markdown rendering, server-side history browsing, or cross-device restoration. Reopening a populated tab re-reads each stored terminal result; concurrent reads multiply Function/database load and have not been load-qualified.

Sandbox lifecycle, durable workspace/artifacts, streaming outbox/replay, and heavy delegated execution are not delivered by this Function slice. Future hosts must preserve native Pi identity, fencing, authorization, and result semantics.
