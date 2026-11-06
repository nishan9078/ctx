# Phase P01 Implementation Report

Date: 2026-11-06. Branch: `roadmap/p01-domain-contracts`. Scope: roadmap Phase 01 only.

## Goal

Freeze the vocabulary and interfaces used throughout CTX.

## Changes

| Files | Behavior |
| --- | --- |
| `packages/shared/src/domain.ts` | Neutral V1 task, attempt, worker-event, verification, capacity, approval, notification and portable checkpoint contracts. |
| `packages/shared/src/validation.ts`, `errors.ts` | Strict schema-v1 task/checkpoint parsing and serialization, safe actionable field errors, shared error codes, bounded inputs and credential redaction before serialization. |
| `packages/shared/src/transitions.ts`, `legacy-transitions.ts`; `packages/core/src/state-machine.ts` | Explicit immutable V1 lifecycle table plus a compatibility facade for existing persisted runner transitions. |
| `packages/shared/src/config.ts`; `packages/core/src/config.ts`; `packages/shared/src/redact.ts` | Validated owner config, defaults/environment precedence, exact canonical repository allowlist resolution and redacted diagnostic views. |
| `packages/core/src/commands.ts` | Typed submit/cancel/pause/resume/approve-or-reject/retry/query interface, revision expectations, actor context and structured results. |
| `packages/persistence/src/task-record.ts`, `database.ts`; `packages/core/src/types.ts` | Relocated legacy storage types and removed persistence imports of core; existing public type imports still work. No data/schema migration. |
| `packages/shared/src/verification.ts`, `contracts.ts`; `packages/verification/src/planner.ts` | Moved verification plan types to neutral ownership, preserved old exports and removed shared imports of implementation code. |
| `scripts/check-package-boundaries.mjs`; root `package.json` | Added `pnpm check:boundaries`, parsing TypeScript imports/exports/import types/dynamic literal imports to reject package cycles and shared-to-implementation imports. |
| `tests/fixtures/domain.ts`; `tests/unit/domain.test.ts`, `config.test.ts`, `command-contracts.test.ts` | Valid and malformed documents, lifecycle scenarios/invariants, legacy transitions, configuration permissions/precedence, redaction and compile-time interface coverage. |
| `docs/decisions/ADR-001-domain-contracts.md`, `docs/architecture/package-ownership.md` | Contract versions, lifecycle/legacy separation, command/config boundary, ownership of all roadmap areas, and retained architecture decisions. |

Phase 00 files and the untracked user audio file were carried forward unchanged except for explicit current-state/roadmap progress links. No existing tests were removed or weakened, no dependency version was changed in P01, and no live provider or external service action was started.

## Verification performed

Commands ran from `/home/nishan/ctx` using Node 22.22.1 and pnpm 12.16.1; native UI checks use the existing bundled Node 26.4.0 runtime.

| Command | Exit code | Result / saved evidence |
| --- | ---: | --- |
| `pnpm typecheck` | 0 | Strict public contracts and compile-time negative probes pass; `typecheck.log`. |
| `pnpm test` (authorized host context) | 0 | Builds through `pnpm build`/`tsc`, then **170 tests: 165 passed, five live cases skipped, zero failures**; `test.log`. This is 52 additional passing tests over P00. |
| `pnpm test:tui` | 0 | Builds again, then four native OpenTUI tests pass; `tui.log`. |
| `pnpm check:boundaries` | 0 | No source package cycles, including type-only imports; shared imports no other implementation package; `boundaries.log`. |
| `git diff --check` | 0 | No whitespace errors in tracked changes. |

The regression suite uses deterministic adapters and real local Git/process/SQLite/filesystem checks. It includes existing crash recovery, duplicate-lease protection, verification failure, immutable requirements, cancellation, host-fallback policy and terminal-controller tests. The five skipped live cases remain four real Codex tasks and one Docker/PostgreSQL scenario. No live security scan, Discord, MCP or OpenCode task coverage is claimed.

An intermediate typecheck caught a duplicate property in a test-fixture expression; that expression was corrected and the final strict check and full suite pass. No failing check was bypassed. The final regression run includes serializer redaction of escaped credentials.

## Acceptance evidence

| Requirement | Evidence |
| --- | --- |
| P01-01 | All eight named public domain types plus checkpoint type in `shared/src/domain.ts`; exhaustive discriminated worker-event handling checked by TypeScript. |
| P01-02 | `validateTaskSpec`, `parseTaskSpec`, `serializeTaskSpec`, `validateCheckpoint`, `parseCheckpoint`, `serializeCheckpoint`; valid round trips and rejected unknown versions/fields, malformed JSON, sparse collections, invalid hashes and traversal. |
| P01-03 | Ownership map covers core, scheduler, persistence, adapters, runtime, verification, integrations and CLI; boundary checker reports no cycles. Empty packages were not introduced. |
| P01-04 | V1 structural table rejects completion shortcuts, terminal reopening, self-transitions and unknown runtime states; scenario tests cover dependency order, repair, waits, retry and pause. Legacy runner semantics remain tested separately. |
| P01-05 | Typed command names/input/output/result maps and `CommandBus.execute`; negative compile probes reject raw-string specs, unbound approvals and wrong response shapes. |
| P01-06 | Validated defaults < owner config < supported environment overrides; exact canonical repository checks; tests reject parent authorization, unregistered projects, bad bounds and null/sparse config; secrets absent from safe diagnostic snapshots. |
| P01-07 | Shared stable `ErrorCode` union, `CtxError`, `ValidationError`, `InvalidTransitionError`; safe serialization and actionable field-path tests. |
| P01-08 | ADR-001 records domain/config decisions and explicitly retains SQLite WAL, isolated worktrees, SDK-first Codex and ordinary non-LLM Sentinel; links baseline ADR. |
| P01-09 | Typed fixtures, malformed task/checkpoint/config cases, transition scenarios, public-interface compile probes and passing existing regression suite. |

## Open risks / limitations

- These are V1 contracts. Existing SQLite v2 records keep legacy types/states; P02 must implement an explicit migration or compatibility/import strategy. New validators are not retroactively applied to arbitrary legacy JSON rows.
- Command bus interfaces do not implement durable submission, cancellation, authorization or approvals. P02/P03 supply transactional handlers, guarded lifecycle changes and evidence/lease enforcement; P08 supplies IPC.
- Structural transition validation is insufficient to authorize completion or release a worker. Active-worker pause/quiescence and fenced transitions remain P03/P05 work. Queued/waiting pause semantics are defined here.
- New `WorkerEvent` normalization is the P04 adapter target. The currently tested Codex adapter still emits its existing SDK events.
- Owner config is programmatic validated input in this phase; file/ingress loading and CLI-to-daemon wiring follow later. Secrets stay outside config, and redaction is best-effort hygiene rather than proof that arbitrary unknown secrets can be detected.
- Phase 00's optional Docker prerequisite P00-ENV-01 (missing fixture image) remains open; it does not affect these contract gates. No image was downloaded and no live fixture failure was relabeled as success.

## Phase gate

**PASS.** Invalid lifecycle transitions and malformed/unknown schemas are rejected; all public types compile in strict mode; the dependency check proves no package cycles, including type imports. Existing runner/UI regressions pass. This establishes Phase 01's contract gate, not MVP/V1 readiness.

## Suggested next phase

**P02 — Persistent storage, migrations, and audit events.** Implement schema evolution, registered projects, task dependencies, transactional submission/events/outbox, deduplication, revision checks, atomic artifacts and backup/restore against the new contracts. Preserve and explicitly handle legacy schema-v2 records.
