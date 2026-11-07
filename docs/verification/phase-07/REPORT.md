# Phase P07 Implementation Report

## Goal

Fix common mistakes and outages without spinning forever or hiding failures.

## Changes

- Added a structured-first failure taxonomy with bounded fallback heuristics, separate approval/auth/security/network/crash/missing-file/install/environment/budget diagnoses, and conservative unknown-outcome handling. No speculative LLM diagnosis calls.
- Added opt-in `recovery` configuration to `createCodexQueueScheduler`: task/class/repeat caps, capped exponential backoff with jitter, aggregate elapsed/reported-token limits and fail-closed optional cost ceilings. Existing per-attempt runtime budgets remain active. Automatic scheduling never resets task attempt epochs.
- Added schema-versioned, hash-bound portable checkpoint artifacts containing completed/pending steps, current changed paths, retained session, branch/base, report and workspace identity. Resume validates specification/profile/policy, report artifacts and the current tree before using the retained worktree. Stale or changed evidence blocks.
- Failed verification can produce a concise repair packet and resume the same Codex session/worktree. Every required verification gate runs again. Identical repeated failures and exhausted bounds become blocked with retained evidence. Security/scope/test-integrity rejection is not routed into automatic model repair.
- Recovery scheduling checks approval state transactionally. Rejected approvals now prevent ordinary manual retry as well as automatic recovery. Existing leases, ownership, archive and nonpassing crash-report contracts remain in use; no migration or adapter upgrade.
- Reused the existing approved EnvironmentManager for disposable PostgreSQL/mock services and explicit frozen dependency installation. It retains persisted recovery intent, resource ownership, permission checks and mock/live labels. Ordinary queue environment failures remain blocked until approved infrastructure is prepared; there is no automatic host-service startup.

## Verification performed

All provider execution in the new tests is **controlled/fake**; compiler/build/tests and filesystem/Git verification are **real local execution**. Infrastructure tests label **simulated Docker** separately from the real local mock HTTP fixture. No new live provider, paid scanner, Docker-image download, external credential or production operation was used.

| Command | Exit code | Result |
|---|---:|---|
| `pnpm typecheck` | 0 | `typecheck.log` |
| `pnpm test` (includes `pnpm build`) | 0 | **316 passed, 6 existing opt-in skips**; `regressions.log`. Before final aggregate verification-deadline adjustment, which is covered below. |
| `pnpm check:boundaries` | 0 | `boundaries.log` |
| `releases/ctx-linux-x64/runtime/bin/node --test --test-reporter=tap dist/tests/unit/recovery-policy.test.js dist/tests/integration/queue-recovery.test.js dist/tests/integration/environment.test.js` | 0 | **29 passed**, no skips; `bundled-runtime.log` |

Final source validation also runs `pnpm build` (exit 0, `build.log`) and `node --test dist/tests/unit/recovery-policy.test.js dist/tests/integration/queue-recovery.test.js` (exit 0, **7 passed**, `final-focused.log`). This includes the aggregate verification deadline added after full regression.

Subprocess checks use authorized local execution because the restricted context suppresses child-process stdout. No check was skipped or weakened to pass.

## Acceptance evidence

- `queue-recovery.test.ts`: deliberately wrong code fails independent tests, resumes the same private worktree, receives one repair, reruns all gates and completes. The original source remains unchanged.
- The unfixable fixture repeats the same failure twice and becomes blocked with exactly two attempts, proving bounded execution.
- A separately opened repository reads the durable checkpoint and preserved diff; modifying the retained tree rejects resume. A rejected approval prevents manual retry. Scheduling also checks pending/rejected/expired decisions inside its transaction.
- Zero-token and unknown-cost accounting fixtures prove the provider is never invoked when those budgets cannot be met.
- `recovery-policy.test.ts`: each taxonomy class, structured precedence, constrained heuristics, attempt/class/identical bounds, elapsed/token/cost accounting and jitter limits have deterministic coverage.
- Existing `environment.test.ts`: disposable PostgreSQL recovery precedes model repair, missing permissions block installation, interrupted intent cannot be replayed, unrelated containers cannot be adopted or removed, unhealthy databases remain blocked, and mock coverage explicitly leaves live integration unverified.
- Existing Phase 05 crash/process ownership tests and Phase 06 verification/report/timeout/mock/approval-evidence tests remain in the full regression suite.

## Open risks / limitations

- Recovery is opt-in through the scheduler API. CLI exposes Phase 06 details/evidence; a general recovery configuration UI is later work.
- No fresh live Codex repair or live Docker/PostgreSQL demonstration was performed. Controlled harness tests do not certify provider availability or end-to-end unattended operation.
- Unknown external effects and crashes without a trustworthy completed verification checkpoint remain blocked. Recovery does not replay ambiguous implementation or infrastructure actions. Checkpoint reopen is tested; relocation to a different machine is not.
- Token ceilings use provider-reported usage at event boundaries, so they cannot prevent generation already performed before telemetry arrives. Aggregate elapsed time aborts execution; per-attempt supervision still handles quiescence. A requested cost ceiling blocks before invocation because this pinned adapter lacks authoritative cost telemetry.
- The existing infrastructure manager is preserved as a separate approved mechanism, not automatically connected to the ordinary queue's verification backend. Unsupported environments require owner reconciliation. No production database or credential fallback is introduced.
- No schema changes, global settings, dependency upgrades or new live service calls. Linux remains the tested process/runtime platform. Release, live M1 and unattended gates remain separate.

## Phase gate

**PASS — tested Linux, opt-in bounded recovery contract.** The five phase exit checks have deterministic acceptance evidence. Live provider repair and unattended/release readiness are not claimed. Implementation commit: `473d623`.

## Suggested next phase

Phase 08 — Sentinel daemon, event waking, and sleep state. It must use the durable deadlines, fenced ownership, checkpoint validation and bounded recovery decisions established here. Live M1 acceptance remains required before Discord integration.
