# ADR-003: Atomic ingress, task revisions, and task repository ownership

Date: 2026-11-06. Status: accepted for Phase 02 transactional submission.

## Decision

`TaskRepository` owns V1 project registration, task submission, dependency edits, administrative state transitions and their audit/outbox queries. SQL stays inside persistence. Shared domain/repository types describe the API without importing core. Core's existing command contract re-exports the neutral actor/snapshot types, preventing a persistence/core dependency cycle.

Registration is an explicit trusted owner operation: resolve the directory to its canonical absolute path, store a unique project ID/path with policy/profile identity, and audit its creation. Identical registration is idempotent. Reusing an ID/path with different policy/profile identity is a conflict. A task cannot register a project or override its verification profile. Registration checks directory access at that time; the scheduler/runtime must recheck at use time.

Submission validates schema-v1 input, redacts known environment credentials, and takes `BEGIN IMMEDIATE`. In one transaction it writes the task, hard dependency edges, queued audit event, accepted notification and inbound deduplication record. Return an acknowledgement only after COMMIT. If any step fails, roll back all of them. Incoming prerequisites must already exist; batch import must use topological order until an explicit atomic batch API is added.

Ingress uniqueness is `(source, deduplicationKey)`. Store a SHA-256 fingerprint of the normalized accepted spec, trusted actor identity and delivery destination. Object property ordering is normalized by schema construction. Same-key/same-payload replay returns the existing task and acknowledgement identity without new rows. Reusing the key with a changed task, principal or route is a conflict. Request IDs may change on transport retry. Deduplication hashes and acknowledgement keys contain no plaintext task credentials; raw ingress labels reject known secrets and control characters.

Actor identity and delivery routing come from trusted ingress, separately from task content. Repository types do not authenticate a caller. There is no remote listener in this feature; authorization remains the responsibility of future command/IPC/Discord ingress. No notification is sent by this repository.

Keep the operational database handle and credential-redaction environment in JavaScript private fields. An object inspection or JSON diagnostic must not dump the process credential context; the redaction tests cover this boundary as well as persisted values.

## Revisions, graphs and state

Dependency edits and supported administrative transitions require the expected revision. Check the version under the write lock and update with `WHERE id=? AND revision=?`; increment exactly once with an actor/reason audit event in the same transaction. Failed audit insertion rolls back the state/specification/edges too. Dependency edits are limited to non-runnable states with no active attempt. A recursive dependency query rejects direct/transitive cycles and missing prerequisites before replacing edges. Stored JSON dependency lists and relational edges must agree on reads.

Administrative transitions enforce the Phase 01 table, active-attempt/approval guards and dependency completion before `ready`. They cannot claim a worker, resume capacity/approval waits, or finalize success. Those operations need their later lifecycle APIs with fencing, persisted deadlines and verification evidence. This feature does not add a scheduler or infer completion from an agent response.

Read transactions keep multi-statement task/specification/dependency projections consistent. Task lists, events and pending-notification queries are bounded and can be paged. Acknowledgement content/identity is immutable through this API; returned delivery metadata comes from the durable outbox columns so retry/delivery state cannot be hidden by an old JSON payload.

## Verification and remaining work

The fixture worker commits 15 tasks with dependencies and mixed queued/paused/waiting states, sends an acknowledgement snapshot and holds its DB open. The parent SIGKILLs it, confirms process exit, reopens the repository and compares identities, states, revisions, specifications, dependencies, events and notifications. Separate processes race an identical submission and produce one task/acknowledgement. Injected SQLite failures at outbox and inbox insertion prove rollback both before and after the outbox row exists. Stale revisions, transitive cycles, malformed inputs, inconsistent stored notification identity, and audit insertion failures are covered.

These are deterministic local persistence tests, not live harness or Discord demonstrations. Full artifact backup/restore, atomic artifact manifests and retention remain Phase 02 work. Worker claims and all execution/cancellation lifecycle operations remain Phase 03 and later. Existing legacy runner records remain unchanged and are not silently imported. See the [feature report](../verification/phase-02/transactional-submission.md).
