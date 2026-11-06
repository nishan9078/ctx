# Phase P04 Implementation Report

Date: 2026-11-06. Branch: `roadmap/p04-codex-worker`. Starting commits `4bbc86c` and `02502b3` preserved and repaired forward.

## Goal

Execute a real Codex-backed task from the durable queue, persist canonical events/evidence and session identity, and own cancellation/recovery without binding scheduler logic to SDK stream shapes.

## Changes

- Repaired ESM SDK version probing, CLI warning handling, historical schema 4 backup compatibility, verification-step SQL arity and conflicting session replacement. Migration 5 from the starting commits remains unchanged; historical SQL/checksums are preserved.
- Integrated `CodexQueueWorker` and `createCodexQueueScheduler` with existing snapshot/worktree preparation, task packets, fenced persistence, configured-model metadata, immutable log segments, command output, diff and result artifacts.
- Added a supervised SDK IPC host, sequential durable acknowledgements, Linux process identity/group ownership, abort/termination escalation, descendant cleanup and supervisor-disconnect cleanup. Expired-owner reconciliation holds capacity for live/unknown recorded workers.
- Corrected canonical sequence allocation and empty message handling; malformed streams cannot become successful, command success requires exit zero, artifact-write errors propagate, and unknown additive SDK events remain diagnostics/raw evidence.
- Injected a neutral finalization pipeline. Fixture completion remains independently verified. A completed real harness turn releases its lease into an explicit blocked engineering-verification handoff; it does not complete the task or bypass Phase 06.
- Added explicit opt-in resume of a quiescent prior session/workspace, safe pre-launch resource retry, auth/rate-limit/error handling and deterministic failure-injection fixtures. Kept SDK/CLI 0.166.0 and the SDK-only decision in ADR-006.

API and lifecycle details: [durable Codex queue](../../architecture/codex-queue.md). Foundation and process-specific evidence: [foundations](foundations.md), [processes](processes.md).

## Verification performed

Development Node 22.22.1, pnpm 12.16.1; bundled Node 26.4.0. Commands below ran in the authorized execution context because restricted sandbox subprocess output is suppressed. An initial sandbox full-suite run failed in seven test files with empty child output; a minimal spawn reproduces it. A bundled sandbox subprocess fixture also stalled and was explicitly stopped/cleaned before the authorized run. No checks were weakened or skipped to obtain a pass.

| Command | Exit | Result/evidence |
| --- | ---: | --- |
| `pnpm test` | 0 | **264 total: 258 passed, 6 opt-in live skips**, zero failures. `test.log`. Includes current build and all legacy/queue regressions. |
| `pnpm typecheck` | 0 | Strict TypeScript checks; `typecheck.log`. |
| `pnpm check:boundaries` | 0 | No cycles or shared-to-implementation imports; `boundaries.log`. |
| `releases/ctx-linux-x64/runtime/bin/node --test --test-reporter=tap dist/tests/integration/codex-queue.test.js dist/tests/integration/codex-process.test.js dist/tests/integration/codex-persistence.test.js dist/tests/integration/queue-migration.test.js` | 0 | **20 passed** on Node 26.4.0; `bundled-runtime.log`. |
| `HARNESS_CODEX_QUEUE_LIVE=1 node --test --test-reporter=tap dist/tests/integration/codex-queue-live.test.js` | 0 | **1 real provider smoke passed**, ~16 seconds; `live.log`. |

The live smoke used existing authentication/configuration and one approved disposable fixture. It created `result.txt` with exactly `phase04-live\n` in the isolated worktree, verified its exact bytes and diff independently in the test, preserved the source checkout, and confirmed an empty owned process group afterward. The task remained blocked pending its required engineering verification; the harness attempt completed.

- CLI and SDK: **0.166.0**, probed without exposing credentials.
- Persisted thread: `01a1b095-ce23-7660-be45-baee91da91b8`.
- SDK-reported usage: **38,646 input**, **136 output**, **24,832 cached input** tokens; cache-write and reasoning output counters were reported as zero. Model/provider identity is unknown; monetary cost was not supplied and is not estimated.
- Live run: `.harness/phase04-live/7d908979-ee9b-4a2e-a98d-e26fa9ccd5ed/`; database, worktree and original immutable artifacts retained there.
- Reviewable exports: `live.diff`, `live-result.json`, `live-summary.json`, `live-attempt.json`. The last includes canonical/diagnostic rows, the complete accepted raw event stream and artifact hashes. Text evidence uses existing best-effort known-secret redaction.

## Acceptance evidence

| Roadmap item | Demonstration |
| --- | --- |
| P04-01 | Correct actual CLI/SDK probes, credential-presence diagnostics, successful real authenticated execution. |
| P04-02 | SDK start/stream/abort; explicit recorded-session/workspace resume in a new fenced attempt; fresh retries retain previous evidence. |
| P04-03 | Canonical messages/tools/commands/files/usage/terminal events, diagnostic forward compatibility, malformed/truncated/failure guards. |
| P04-04 | Immediate thread capture, transactional event sequences/delivery deduplication, stale-fence rejection, reopen persistence and process ownership records. |
| P04-05 | Objective/scope/acceptance/profile/result format, isolated worktree and actual SDK thread restrictions. Source edits preserved in tests. |
| P04-06 | Cancellation of resistant descendants, leader-first exit cleanup, abnormal child exit, sink failure and supervisor SIGKILL. Controlled SDK executable tests; no live provider is required to exercise signal races. |
| P04-07 | Missing credentials/CLI preflight, auth error and explicit rate-limit fixtures, safe pre-launch retry deadline, uncertain transport/exit blocked for reconciliation. |
| P04-08 | Stub normalizer contracts, installed-SDK executable fixtures, scheduler/persistence/process integration, optional real smoke passed. |
| P04-09 | SDK remains the only orchestration path. No App Server implementation exists or was added. ADR-006 retained. |
| P04-10 | Real attempt raw/canonical logs, command evidence, diff, terminal result and reported token counters retained; no invented billing/model identity. |

## Limitations and next dependencies

- Full resource limits, malicious process escape containment, worktree lifecycle/cleanup ownership and platform expansion remain Phase 05. Verified process supervision is Linux/POSIX only.
- Required ordinary engineering checks/security gates are not implemented by the queue handoff. Phase 06 must provide those gates before an ordinary task can become completed. The smoke's independent exact-file assertion does not stand in for the configured engineering verification profile.
- CLI/OpenTUI retain the legacy runner; the durable Codex queue is a local composition API. No daemon or unattended/release readiness is claimed.
- Credential presence does not establish token validity; actual auth failures are surfaced. Known-secret redaction is not a comprehensive secret scanner. Bounded canonical projections may truncate long content; full accepted raw event artifacts are retained within artifact/task budgets.
- Existing Docker/Postgres live coverage is not part of this phase and was not run. Other legacy live suites remain opt-in.

## Gate status

**Phase 04 passes:** approved fixture edited with reviewable diff; start/finish/error recording is truthful; killed/truncated workers cannot complete tasks; cancellation/orphan cleanup leaves no owned live group in tested scenarios; scheduler lifecycle logic is adapter-agnostic. Next: **Phase 05 — Worker runtime, resource limits, and Git worktree ownership**.
