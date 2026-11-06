# Phase P02 transactional submission report

Scope: P02-03 through P02-07 and their persistence contracts. Branch: `roadmap/p02-task-repository`. Goal: preserve each accepted task and its acknowledgement transactionally across process restarts. The full Phase 02 gate remains pending artifact/backup work.

## Changes

- `packages/persistence/src/task-repository.ts`: V1 project registration, runtime-validated task submission, dependency validation/editing, revision-guarded administrative state updates, immutable audit append and acknowledgement/outbox queries. Every mutating method uses an explicit transaction.
- `packages/shared/src/domain.ts`, `repository.ts`; `packages/core/src/commands.ts`: neutral actor/snapshot/repository contracts; core compatibility exports preserve the command API without a persistence-to-core import.
- `tests/fixtures/repository.ts`, `repository-worker.ts`; `tests/integration/task-repository.test.ts`: deterministic failure injection, actual child-process SIGKILL/reopen and concurrent-ingress coverage.
- `docs/decisions/ADR-003-transactional-submission.md`: accepted identity, deduplication, revision, graph and audit boundaries.

No historical migration SQL, legacy task format or existing test was changed. No fixture notification was sent externally. This is the persistence API for the future V1 command service; CLI/OpenTUI still use the existing tested legacy runner until their planned integration phases.

## Verification

| Command | Exit | Result / evidence |
| --- | ---: | --- |
| `pnpm build` | 0 | `repository-build.log`; the final regression command also rebuilds the complete project. |
| `node --test dist/tests/integration/task-repository.test.js` (authorized host context) | 0 | Initial 14 repository contracts passed in `repository-contracts.log`. The subsequent inbox-failure contract and dependency-edit rollback assertion are included in the final full suite. |
| `pnpm typecheck` | 0 | `repository-typecheck.log`; strict compilation includes public command contracts. |
| `pnpm check:boundaries` | 0 | `repository-boundaries.log`; zero source package cycles, including type imports, and no shared-to-implementation dependencies. |
| `pnpm test` (authorized host context) | 0 | `repository-test.log`: **192 tests, 187 passed, five live cases skipped, zero failures**, including all 15 repository tests. |
| `git diff --check` | 0 | Whitespace verification. |

The five skipped live cases remain the four real Codex tasks and Docker/PostgreSQL acceptance fixture. No live provider/security scan or external service coverage is claimed. UI renderer code is unchanged; the regression suite includes the existing terminal controller/integration checks.

## Acceptance evidence

| Requirement | Demonstration |
| --- | --- |
| P02-03 | Private persistence SQL and explicit write/read transactions; no new UI SQL. |
| P02-04 | A single submit commits spec, dependency rows, audit event, inbox identity and accepted outbox notification. Outbox/inbox failure injection proves rollback of every row. |
| P02-05 | Two connections read revision 1; after one commits revision 2, the stale writer is rejected. Dependency edits likewise require and increment the expected revision. Failed audit insertion preserves the old revision and contents. |
| P02-06 | Unique task/project/ingress IDs, immutable project identity, profile binding, unknown-project/dependency rejection, direct/transitive cycle rejection, and simultaneous duplicate submission by two actual processes. |
| P02-07 | Every supported administrative state change and dependency edit appends timestamp, actor, reason and revision evidence in the same transaction. Missing audit insertion prevents the change from committing. |
| P02-10 contracts | SIGKILL of an acknowledged 15-task worker and authoritative process exit, reopen with exact task/event/outbox equality, duplicate replay without new rows, partial-transaction failures and prior malformed-migration tests. |

## Limits and next dependencies

The repository is for trusted local services; its actor fields do not authenticate remote users. Directory availability must be checked again before execution. Dependencies must exist at submission; an importer must submit prerequisites first. Known-secret redaction is log/data hygiene, not a complete scanner for arbitrary unknown credentials.

Worker claims, fenced execution transitions, waiting-capacity/approval lifecycle handling, verified completion and process cancellation belong to Phase 03 and later APIs. Administrative methods deliberately refuse those paths. No existing terminal task is silently added to the V1 queue.

**Subtask gate: PASS. Full Phase 02 gate: PENDING.** Remaining work: P02-08 atomic artifact writer/SHA-256 manifests, P02-09 complete database-plus-artifact backup/restore command, P02-11 retention/redaction defaults for artifacts, and the final phase audit. This feature proves the 15-task restart, duplicate-ingress and failed-transaction exit checks; it does not prove full artifact restore.
