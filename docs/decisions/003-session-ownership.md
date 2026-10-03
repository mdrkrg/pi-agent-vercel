# Session ownership and fencing

A writable session has one active writer under a durable lease with a monotonically increasing fencing epoch. Expiry permits takeover; it does not authorize stale work.

Every leased mutation validates current writer ownership and epoch atomically with its writes. Once ownership is lost, the old writer cannot publish. Lease identity belongs to the application control plane, not Pi operation state or the conversation transcript.

Admission and drive passes use the same fencing contract. Epochs must not reset on release or holder-id reuse. Waiting/retrying work releases ownership so a later pass can resume.

Drive passes renew both session ownership and their queue claim. Ownership loss, cancellation, or deadline must seal the harness effect gate and stop the observer. This does not reverse a remote effect or turn host shutdown into a durable user abort; Pi's committed state remains recoverable.

Lease-row locking, release/renewal mechanics, and lifecycle ordering are documented in [implementation](../runtime-implementation.md).
