# Contract-first persistence

The Postgres adapter must satisfy the upstream Pi Storage and SessionRepo contracts before application behavior is added. The upstream contract suite is the compatibility boundary; application tests pin recovery, replay, fencing, and authorization behavior that is outside that contract.

The adapter remains transaction-oriented and backend-neutral. Application code must not reproduce Pi's operation state machine.
