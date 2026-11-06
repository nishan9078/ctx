# Phase P02 Implementation Report

Date: 2026-11-06. Final feature branch: `roadmap/p02-artifacts-backup`.

## Goal

CTX remembers every task and event across process restarts.

## Changes

Phase 02 builds on three verified storage features:

1. [Storage foundation](storage-foundation.md): schema-v3 initialization, SQLite settings, transactional/checksummed migrations and private WAL-aware automatic pre-migration database snapshots; legacy schema-v2 records are preserved.
2. [Transactional submission](transactional-submission.md): registered projects, validated task/dependency submission, ingress deduplication, revision checks, actor/reason audit events and durable acknowledgement outbox records.
3. Atomic managed artifacts and complete database-plus-registered-evidence backup/restore, implemented in this feature:

| Files | Behavior |
| --- | --- |
| `shared/src/artifacts.ts` | Artifact record/manifest contracts and explicit byte/count/retention/redaction defaults. |
| `persistence/src/artifact-store.ts`, `artifact-files.ts` | Private staged writes, fsync and directory rename; bounded streaming verification/copy; path/symlink guards; strict versioned manifests. |
| `persistence/src/task-repository.ts` | Hash-verified artifact registration plus immutable audit binding for the canonical manifest; bounded metadata query and verified artifact reader. Failed DB writes cannot acknowledge an artifact or leave a dangling reference. |
| `persistence/src/backup.ts` | Writer-locked SQLite backup including committed WAL data, complete file inventory, hashes, budgets, schema/task consistency verification and clean-directory restore publication. Includes historical registered artifacts without following old worktree paths. |
| `persistence/src/database.ts`, `migrations.ts` | Bounded fail-closed legacy restore marker handling; shared migration-history verification without rewriting historical SQL. |
| `apps/cli/src/index.ts` | Explicit `ctx backup <new-directory> --database <file>` and `ctx restore <backup-directory> --output <new-directory>` commands. |
| `tests/fixtures/artifact-worker.ts`, `tests/integration/artifacts-backup.test.ts` | Artifact crash/rollback, redaction/binary policy, tampering, restore, legacy archive and actual CLI contract coverage. |
| `docs/BACKUP_RESTORE.md`, `docs/decisions/ADR-004-artifacts-backup.md` | Operating instructions, publication/verification rules, policy defaults and compatibility limits. |

Paths in this table are relative to `packages/` except apps/tests/docs. No existing test or migration SQL was weakened or replaced. There is no new dependency or external service operation.

## Verification performed

Run from the repository with Node 22.22.1/pnpm 12.16.1. Authorized host execution permits the existing local subprocess/crash fixtures; all new data is disposable temporary state.

| Command | Exit | Result / evidence |
| --- | ---: | --- |
| `pnpm build` | 0 | `artifacts-build.log`; final full suite also rebuilds through strict `tsc`. |
| `node --test dist/tests/integration/artifacts-backup.test.js` | 0 | Initial 14 contracts passed; `artifacts-contracts.log`. The additional immutable-manifest-policy tampering case is included in the final full suite. |
| `pnpm typecheck` | 0 | `artifacts-typecheck.log`. |
| `pnpm check:boundaries` | 0 | `artifacts-boundaries.log`: no package cycles, including type imports, and no shared-to-implementation dependency. |
| `pnpm test` | 0 | `artifacts-test.log`: **207 tests, 202 passed, five live cases skipped, zero failures**. Includes all 15 artifact/backup contracts and prior migration/repository contracts. |
| `pnpm test:tui` | 0 | `artifacts-tui.log`: four native renderer tests using the bundled Node 26.4.0 runtime. |
| `git diff --check` | 0 | Source/evidence whitespace verification. |

Skipped cases remain four real Codex tasks and the opt-in Docker/PostgreSQL fixture. No live generation/security scan, image pull, Discord or MCP test was run. This phase proves local storage contracts, not harness execution or unattended V1 readiness.

## Requirement-by-requirement acceptance

| Requirement | Current authoritative evidence |
| --- | --- |
| P02-01 | `openOrchestrationDatabase` and migration tests prove WAL/FULL sync, foreign keys, busy timeout, fresh/reopen paths, supported upgrades, checksummed history and transactional rollback. |
| P02-02 | Strict V1 tables cover every named entity, plus sessions, verification, settings and locks; schema tests inspect tables and relational/uniqueness constraints. Legacy tables remain separate. |
| P02-03 | Task/project/artifact repositories own SQL and explicit transactions. UI calls storage operations rather than issuing new SQL. |
| P02-04 | Submit inserts task, dependencies, audit event, inbox and acknowledgement in one transaction; failures at outbox and inbox insertion leave none of the partial rows. |
| P02-05 | Competing connection with a stale revision cannot change state/dependencies. Successful updates increment the revision atomically with their event. |
| P02-06 | Project/task/ingress uniqueness, registered profile binding, missing prerequisite refusal, transitive cycle detection and two-process duplicate-ingress race are tested. |
| P02-07 | Every supported V1 administrative transition, dependency edit and artifact registration records actor/reason/timestamp. Injected event failure rolls back the associated update. Worker-specific transitions remain reserved for their guarded P03/P06 APIs. |
| P02-08 | Actual SIGKILL at artifact staging boundary leaves zero artifact DB references. Ordinary failures clean staging; failed metadata publication leaves only unreferenced files. Published content and canonical manifest hashes are verified against DB/audit records. |
| P02-09 | Automatic pre-migration snapshots are tested separately. New CLI/API backup restores 15 tasks, events, notifications and all text/binary artifacts into a clean directory after the original source directory is removed. Integrity/foreign-key checks and verified artifact reads pass. |
| P02-10 | Existing migration tests cover malformed DDL/history and retained backups; repository tests cover process kill/reopen, partial rollback and duplicates; artifact tests cover interrupts, tampering, missing files, symlinks, traversal and actual backup/restore CLI. |
| P02-11 | Policy defines per-file/task/database/backup budgets, file-count bounds, 30-day log retention eligibility, 24-hour orphan review threshold, evidence preservation and text redaction. Admission/backup budgets and redaction/binary declarations are tested. Scheduled deletion is not enabled. |

## Exit gate audit

- **PASS — 15 acknowledged tasks survive kill/restart:** the repository fixture sends its committed snapshot, is SIGKILLed and confirmed exited, then reopens with exact task identity/state/revision/dependency/event/outbox equality.
- **PASS — duplicate input:** replay and simultaneous two-process submission produce one task and one acknowledgement. Changed payload/principal/route reuse is rejected.
- **PASS — transaction rollback:** outbox/inbox/event failures preserve prior task, dependency, revision, event and acknowledgement state.
- **PASS — clean restore:** standalone SQLite snapshot plus all registered evidence restores after source deletion, with integrity/foreign-key checks and content/manifest verification. Corrupted or inconsistent data never publishes a restored `data/`.
- **PASS — state-change audit:** the V1 repository appends actor, reason, time and revision in the same transaction for every supported state change. Unsupported worker/verification transitions are refused rather than emitted without lifecycle/evidence guards.

## Open risks / limitations

CLI/OpenTUI task execution still uses the preserved legacy runner; V1 queue/worker ownership and command integration are P03/P08 work. This does not establish an autonomous scheduler.

Legacy records/evidence are backed up unchanged but restored as an archive, with explicit worktree/process reconciliation required before legacy reuse. External projects/worktrees/services/credential stores are outside this bundle. V1 task/relative-artifact restoration is fully demonstrated; no silent worker start or automatic live-worktree resume is claimed.

Checksums establish integrity/consistency, not authenticity of an attacker-controlled replacement archive. Use trusted owner backups. Text redaction recognizes known credentials/patterns; binary artifacts and unknown secrets require later scanning. Retention thresholds are defined; automatic archival/pruning and daemon-wide disk/endurance enforcement remain P15 requirements. No registered evidence is automatically deleted.

## Phase gate

**PASS for P02's V1 persistence API and backup/restore deliverables.** All five phase exit checks have current source/test evidence. Existing legacy records are preserved under an explicit archive/reconciliation policy. No MVP/V1 execution or release gate is claimed.

## Suggested next phase

**P03 — Durable scheduler, DAG, leases, and queue APIs.** Use deterministic fake workers to prove dependency eligibility, bounded concurrency, fencing/heartbeats, delayed retries, cancellation and restart reconciliation before harness integration.
