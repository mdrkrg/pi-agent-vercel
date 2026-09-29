# Runtime boundaries

Normal Agent execution targets a short-lived Function-compatible host. Workflow is a scheduler for drive passes, not a second Agent runtime. Sandbox is an optional compute host for workloads that need isolated operating-system execution or a large local workspace.

All hosts must use the same durable session and operation identity. Host selection must not change Agent semantics.
