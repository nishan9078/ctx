# Phase P03 Implementation Report

Date: 2026-11-06. Branch: `roadmap/p03-durable-scheduler`.

## Goal

Make queue execution correct even without a real AI agent.

## Changes

- `packages/persistence/src/queue-operations.ts`: transactional eligibility, deterministic claims, durable settings/control/deadlines, attempt/lease ownership, heartbeat/fencing, quiescent finalization, retry epochs, fixture verification records, notifications and queue query APIs.
- `packages/persistence/src/process-identity.ts`: host/PID/start/boot/namespace ownership checks; unknown identities are not assumed dead.
- `packages/persistence/src/queue-schema.ts`, `migrations.ts`: immutable migration 4, preserving historical records/foreign keys with automatic pre-migration backup; active-worker/drift guards. Historical SQL remains unchanged.
- `packages/persistence/src/task-repository.ts`: shared persistence capability and fenced attempt-linked artifact writes. `backup.ts`/legacy `database.ts` retain recognized v2/v3 compatibility and recognize current v4.
- `packages/shared/src/scheduling.ts`, `domain.ts`, `transitions.ts`: worker/claim/status contracts, explicit fixture identity, guarded recovery/readiness/pause paths; ordinary terminal reopening remains forbidden.
- `packages/core/src/durable-scheduler.ts`, `fixture-worker.ts`: controller heartbeat/abort/timeout management, deterministic fake worker, idempotent receipts and independent fixture verifier.
- `tests/fixtures/queue.ts`, `queue-worker.ts`, `tests/integration/queue.test.ts`, `queue-migration.test.ts`: DAG, contention, controls, deadlines, fencing, crash boundaries and compatibility tests.
- Existing `tests/integration/migrations.test.ts` now derives current/future version assertions from the current schema version, uses explicit lease columns, and injects malformed DDL at the latest migration. Its existing failure/preservation assertions remain intact.

See [ADR-005](../../decisions/ADR-005-durable-scheduler.md) and [queue lifecycle API](../../architecture/queue-lifecycle.md).

## Verification performed

The build/typecheck/full suite use pinned Node 22.22.1 and pnpm 12.16.1. All new activity is deterministic local fixtures and disposable data. No live generation, security scan, provider-capacity probe or external message was started.

| Command | Exit | Evidence |
| --- | ---: | --- |
| `pnpm build` | 0 | `build.log`; the final full suite rebuilds all current sources. |
| `node --test dist/tests/integration/queue.test.js dist/tests/integration/queue-migration.test.js dist/tests/integration/migrations.test.js` | 0 | Initial 27 scheduler/migration contracts; `contracts.log`. Later claim rollback, registration, pause-race and namespace assertions are included in the final full suite. |
| `pnpm typecheck` | 0 | `typecheck.log`; strict public contracts. |
| `pnpm check:boundaries` | 0 | `boundaries.log`; zero package cycles including type imports, no shared-to-implementation imports. |
| `pnpm test` | 0 | `test.log`: **230 tests, 225 passed, five live cases skipped, zero failures**. Includes all 23 newly added scheduler/migration tests and updated baseline migration assertions. |
| Bundled Node 26.4.0 scheduler/migration contract run | 0 | `bundled-runtime.log`; current scheduler/queue migration tests pass using the release runtime as well. |
| `git diff --check` | 0 | Source/evidence whitespace check. |

Five skipped cases remain the existing opt-in real Codex and Docker/PostgreSQL tests. This phase does not relabel simulated capacity, fixture verification or a fake approval as live integration coverage.

## Acceptance evidence

| Requirement | Current source/test proof |
| --- | --- |
| P03-01 | Allowlisted lifecycle transitions and their actor/reason/revision events share the SQLite transaction. A failed claim-audit insert rolls back task state, attempt and lease. |
| P03-02 | Eligibility requires all hard prerequisites completed. The 15-task fixture tree starts in deterministic order, and every child running event follows its parent's completed event. |
| P03-03 | Priority/creation/ID sorting and DB-backed global/per-project slot checks. Independent projects progress with exactly two permitted slots; same-project limits prevent a second claim. |
| P03-04 | Atomic claims, persisted owner identity/expiry, heartbeats and monotonically increasing fences. Expired live owners and foreign/unknown namespaces cannot be stolen; stale event/artifact/cleanup writes fail after a fresh claim. |
| P03-05 | Persisted global drain pause and task intents. Queued and already-claimed-but-unstarted work cannot begin under pause. Revision-checked resume/retry, abort propagation and a signal-ignoring worker prove slot retention until actual quiescence. |
| P03-06 | Simulated capacity/transient waits release the worker and persist a retry deadline. Reopen before the deadline cannot start an early attempt; due wake progresses without a model probe. |
| P03-07 | Fake worker scripts cover sleep/success/failure/capacity/approval. A separate verifier rejects bad receipts and the fixture path cannot claim/complete ordinary engineering work. |
| P03-08 | SIGKILL before output and after receipt; confirmed process exit, expiry/reconcile, preserved 15 acknowledged tasks and one original execution ID for the recovered visible fixture effect. Observation timeout leaves an actually live worker managed. |
| P03-09 | Consistent queue status counters/configuration/next deadline plus durable attempt histories are asserted through success, wait, pause, fail and cancel scenarios. |
| P03-10 | Failed/cancelled/blocked prerequisite chains block descendants with a reason; incomplete prerequisites wait. Neither case launches an invalid descendant. |
| P03-11 | Four processes simultaneously submit 16 tasks and contend for claims: exactly two unique active claims, no task loss/duplicate claim. Confirmed-dead claims then recover and all 16 complete as fixtures. |

Migration tests additionally preserve v3 attempts/artifacts/checkpoints/sessions through the v4 rebuild, keep FK enforcement enabled, reject invalid references after commit, and refuse upgrade with active v3 workers or checksum drift. Existing backup/restore and legacy runner regressions pass.

## Phase exit gate

- **PASS:** 15-task DAG finishes deterministically with fake workers and independently verified fixture-only evidence.
- **PASS:** Failed or incomplete hard dependencies never permit a dependent worker start.
- **PASS:** Forced restart preserves acknowledged task identity; interrupted attempts remain recorded, and idempotent receipt reuse prevents a second visible fixture effect.
- **PASS:** A stale lease cannot update or clean up a fresh attempt; attempt-linked artifact writes are fenced too.
- **PASS:** Global pause persists across reopen, stops claims/unstarted invocations and drains already-running work under its documented policy.

## Open risks / limitations

Completion here proves a controlled fixture contract, not arbitrary engineering work or live Codex/OpenCode behavior. Reports/attempts explicitly identify the fixture worker. Real harness adapters, true process-group termination/reattachment and source-worktree isolation are P04/P05; real verification/commit gates are P06.

General external actions are not exactly-once. Automatic replay is limited to confirmed-dead, known-idempotent fixtures; real worker effects block for explicit reconciliation. On systems without a usable start fingerprint, PID reuse is handled conservatively. Unknown hosts/namespaces remain quarantined. Abort-ignoring workers retain their slot until actual settlement rather than being falsely marked cancelled.

Retry budget counts claims, including interrupted launches. Explicit owner retry creates a new budget epoch/revision while preserving fences. Attempt wall-time is capped; aggregate token/cost/repair controls remain P07. Capacity signals are simulated task deadlines here; real provider/account pools are P11. Approval fixtures only request/wait/expire/cancel, never grant authority; authenticated decisions are P09.

Queue/control APIs are trusted local interfaces. Actor fields are audit context, not authentication. CLI/OpenTUI remain on the preserved legacy path pending their planned command/daemon integration. No always-on daemon, external notification transport or V1/endurance readiness is claimed.

## Phase gate

**PASS for Phase 03's deterministic queue/fixture-worker contract.** All eleven implementation items and five exit checks have current source/test evidence. Full product goal remains active.

## Suggested next phase

**P04 — Codex adapter integration and normalized agent events.** Replace fixture execution with the actual installed SDK behind the same queue/controller ownership contract; preserve truthful verification and cancellation boundaries.
