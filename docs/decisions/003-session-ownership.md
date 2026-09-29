# Session ownership and fencing

A writable Pi session has one active application owner at a time. Ownership is represented by a durable lease with a monotonically increasing fencing epoch; a lease timeout permits takeover but does not by itself authorize stale work.

Every mutable session transaction that runs under a lease validates the holder and epoch while holding the lease row lock. A process that lost ownership fails before publishing writes. Lease acquisition, renewal, and release are application control-plane operations and are separate from Pi operation state.

A drive pass acquires ownership before opening a fenced session and releases it after closing the harness. Waiting or retrying leaves ownership so a later drive pass can acquire it again. The lease identity is never stored in the conversation transcript.
