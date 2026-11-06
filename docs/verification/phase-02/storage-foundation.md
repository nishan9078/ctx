# Phase P02 storage foundation report

Goal: begin **“CTX remembers every task and event across process restarts”** with versioned, recoverable SQLite initialization. This is a bounded Phase 02 subtask; the complete phase gate remains pending.

## Implemented

- `packages/persistence/src/migrations.ts`: async schema-v3 initialization, durable SQLite settings, transactional migrations, checksummed history and validated private automatic pre-migration snapshots, including committed WAL pages. Backups are synced before applying DDL. Unsupported/unknown/drifted schemas and outstanding legacy leases fail closed.
- `packages/persistence/src/orchestration-schema.ts`: all V1 storage tables and indexes, strict types, state/domain constraints, unique active attempts, deduplicated inbox/outbox keys, append-only audit events and task/attempt/fencing foreign keys.
- `packages/persistence/src/database.ts`: legacy `TaskStore` can open migrated schema v3 while preserving its existing record format and behavior.
- `tests/integration/migrations.test.ts`: seven deterministic tests for initialization/reopen, WAL-aware backup, v1/v2 legacy preservation, rollback with retained backup, future/unknown/drifted schema refusal, lease refusal and integrity constraints.
- `docs/decisions/ADR-002-storage-migration.md`: namespace/compatibility, transaction/snapshot rules and remaining boundaries.

No existing task was imported/requeued, no historical evidence was deleted, and the untracked user audio file remains untouched. The new startup API has not yet replaced the legacy CLI execution path.

## Verification

| Command | Exit | Evidence |
| --- | ---: | --- |
| `pnpm build` | 0 | `build.log`; compiler also runs in the final regression suite. |
| `pnpm typecheck` | 0 | `typecheck.log`. |
| `node --test dist/tests/integration/migrations.test.js` | 0 | `migrations.log`; restricted test isolation reports one file-level pass. |
| `node dist/tests/integration/migrations.test.js` | 0 | `migrations-detail.log`; all seven individual migration tests pass. |
| `pnpm test` (authorized host context) | 0 | `test.log`: 177 tests, 172 passed, five opt-in live cases skipped, zero failures. |
| `pnpm check:boundaries` | 0 | `boundaries.log`: no package cycles or shared-to-implementation dependencies. |
| `git diff --check` | 0 | Changed source passes whitespace validation. |

All work uses local temporary databases/fixtures. No real model task, image pull, provider/security scan or external application write was started. Native UI behavior was unchanged; the four UI tests already passed for the preceding feature.

## Remaining Phase 02 work

P02-01/02 storage initialization and schema are implemented as an explicit startup API. P02-09's automatic migration snapshot is implemented; its operational backup/restore command and artifact bundle are not.

Next implement P02-03 through P02-07: repository methods, atomic task/dependency/event/acknowledgement submission, revision checks, deduplication and DAG validation. Then P02-08 through P02-11: atomic artifact store/manifests, full backup/restore commands and retention/redaction defaults. The full phase still needs its 15-task process-kill/restart, duplicate-ingress, transaction rollback, full restore and per-transition audit evidence.

**Subtask gate: PASS. Phase P02 gate: PENDING.**
