# ADR-002: Migrate V1 storage alongside legacy runner records

Date: 2026-11-06. Status: accepted for Phase 02 storage foundation.

## Decision

Use one local SQLite database with WAL, FULL synchronization, foreign keys and a 5-second busy timeout. New V1 tables use the `ctx_` prefix. Existing runner tables and JSON stay intact; they cannot be silently translated into V1 tasks because legacy state, acceptance and attempt semantics differ. A later explicit importer may map them after validation. New V1 tasks must enter through the transactional repository still to be implemented.

`openOrchestrationDatabase` is the async startup migration entrypoint. It initializes fresh files through the historical schema-v2 layout then schema v3. Existing v1 resources gain their v2 columns without losing rows. Existing v2 files gain V1 tables and migration history. The legacy `TaskStore` accepts schema v3 and continues using its unchanged tables; its existing v1-to-v2 bootstrap remains supported for legacy-only callers. Production adoption of the new startup entrypoint belongs to the remaining Phase 02 integration work.

Before upgrading an existing file, acquire `BEGIN IMMEDIATE`, reject outstanding legacy leases, and snapshot committed SQLite state through the SQLite backup API on a separate read-only connection. Holding the writer lock prevents commits between snapshot and migration. This captures WAL contents; copying the main DB file directly would not. Snapshot files are private, checked for integrity/version, and synced together with their containing directories before schema changes. They live under `migration-backups/v<old>-v3-<unique>/state.sqlite` beside the source DB. They are retained on failed migrations.

Apply all pending migrations and the schema-version/history updates in one transaction. Reject unsupported future versions, unknown unversioned nonempty databases, and checksum drift in recorded migrations. Do not repair, downgrade, drop, or automatically restore ambiguous state. Migration SQL is trusted application source; no task/remote input can supply migrations. Historical SQL, including the legacy `schema.ts` content used by migration 2, must remain immutable; future changes require a new migration.

Startup occurs before workers and under single-owner orchestration. A contender may receive SQLite's bounded busy failure and must reopen after the current owner finishes; this API does not introduce a distributed migration coordinator. Outstanding legacy leases require explicit reconciliation rather than interpreting their timestamp as proof that a worker died.

## Schema safeguards

The V1 schema includes projects, tasks, dependencies, attempts, leases, harness sessions, audit events, inbox/outbox, exact-action approvals, artifacts/checkpoints, capacity state, verification runs/steps, scheduler locks and settings. Tables use strict SQLite typing and domain constraints. A partial unique index prevents multiple active attempts per task. Composite foreign keys bind leases to the correct task/attempt/fencing token and artifacts/checkpoints to their owning task/attempt. Audit events reject update/delete. These constraints complement future repository transactions; raw task rows are not yet a functioning queue.

## Limits and next work

The pre-migration snapshot is a database backup, not the complete operational backup/restore deliverable. Referenced artifact copying, manifests, integrity validation of restored artifacts, backup/restore commands, transactional submissions, revision checks and repository-level audit/redaction remain Phase 02 work. No 15-task restart gate has been claimed for this subtask. See the [storage foundation report](../verification/phase-02/storage-foundation.md).
