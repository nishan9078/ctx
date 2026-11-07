# Phase P05 Implementation Report

Date: 2026-11-07. Branch: `roadmap/p05-worker-runtime`. Starting checkpoint: `502707d` (Phase 04). Implementation commits: `91f66a2`, `0cd9dc5`, `e6a71ef`.

## Goal

Every attempt has a safe, disposable, reproducible execution space.

## Changes

- Persistence: immutable migration 6 adds project device/inode identities, workspace ownership and unique attempt-fenced access. Ownership intent is committed before filesystem creation; source replacement, stale claims, shared-workspace access and unaudited identity rebinding are refused. Upgraded project identities require an explicit audited owner registration call. Historical migrations are unchanged.
- Worktree lifecycle: `OwnedWorkspaces` reuses the private snapshot strategy, creates named task branches with recorded base SHAs, validates canonical paths/nonce/inodes, observes cancellation during preparation and refuses unsafe source metadata, symlinks and Git lock/in-progress states. Dotted task identifiers receive safe branch components. Original files and source Git metadata are never reset.
- Evidence and cleanup: exact worktree and private snapshot packages, Git-reference/HEAD hashes, baseline diff, Git bundle and immutable receipts precede disposal. Changes to either tree or Git refs invalidate cleanup. Terminal task, quiescence, retention, archive integrity and ownership checks protect cleanup; unknown directories and recreated paths are never adopted. Interrupted cleanup resumes idempotently. Orphan scanning retains unsafe/incomplete/unarchived resources and can request cleanup only through the same guards.
- Runtime: configurable sampled RSS/observed CPU/workspace disk limits, free disk/available memory preflight, wall deadlines, fenced health diagnostics, final disk checks and bounded separate stdout/stderr capture extend the existing SDK process supervisor. SQLite queue concurrency limits remain authoritative.
- Preparation commands: owned IPC command hosts give local Git operations parent-loss cleanup too, including inherited-output descendants. Scoped sessions serialize commands through one host per Git operation and close at scope end. Private Git clears inherited Git overrides, disables global/system config, hooks/fsmonitor/external diff helpers and refuses unsafe local filters/include/worktree overrides before staging evidence. No global settings or process identities/groups are reset.
- Queue integration: fresh attempts and explicit resume acquire durable workspace access; after worker quiescence, archival preserves output before the existing verification handoff. Ordinary tasks still block pending Phase 06 required verification. Legacy CLI/OpenTUI execution remains available.

Implementation details: [owned workspaces](../../architecture/owned-workspaces.md), [worker runtime](../../architecture/worker-runtime.md), [Codex queue](../../architecture/codex-queue.md), [ADR-007](../../decisions/ADR-007-worker-workspace-ownership.md).

## Verification performed

Development Node **22.22.1**, pnpm **12.16.1**; bundled Node **26.4.0**. CLI/SDK versions and dependencies were not upgraded. All new provider execution is deterministic fixture execution against the installed SDK; no new paid/live generation or production operation was run.

| Command | Exit code | Result |
| --- | ---: | --- |
| `pnpm test` | 0 | **290 total: 284 passed, 6 optional live skips**, no failures. Includes current TypeScript build and all unit/integration regressions. `test.log`. |
| `pnpm typecheck` | 0 | Strict TypeScript passed. `typecheck.log`. |
| `pnpm check:boundaries` | 0 | No cycles or shared-to-implementation imports. `boundaries.log`. |
| `releases/ctx-linux-x64/runtime/bin/node --test --test-reporter=tap dist/tests/integration/owned-command.test.js dist/tests/integration/owned-workspaces.test.js dist/tests/integration/workspace-registry.test.js dist/tests/integration/workspace-crash.test.js dist/tests/integration/runtime-budget.test.js dist/tests/integration/codex-queue.test.js dist/tests/integration/codex-process.test.js` | 0 | **41 passed** on bundled Node 26.4.0. `bundled-runtime.log`. |
| Earlier ownership and workspace checks | 0 | Incremental evidence: `ownership-focused.log` (29), `ownership-regressions.log` (262 pass/6 skips), `workspaces.log` (34). Final logs supersede these intermediate counts. |

Checks ran in the authorized execution context because the restricted sandbox suppresses captured subprocess output (previously isolated in Phases 00/04). No sandbox or host global setting was changed. One new preparation fixture initially failed its live-group assertion; its generated script/readiness signal was corrected. The assertion remained in place and all checks were rerun. No failing check was removed, loosened or replaced with a skip.

## Acceptance evidence

| Requirement | Authoritative evidence |
| --- | --- |
| P05-01: registration/canonical path | Project inode/symlink substitution tests reject claims; schema-5 upgrade preserves events/session records, leaves identities unbound, then requires an audited owner registration and explicit retry. |
| P05-02: branch/base SHA | Real Git creation tests assert the private task branch and baseline SHA, including dotted identifiers. Worker commits are included in a diff against the recorded base. |
| P05-03: supervisor | PID/group identity, graceful/forced termination, SDK stderr/stdout tails and truncation, command exit/output/timeout, controller SIGKILL, resistant descendants and inherited-output cleanup tests pass. |
| P05-04: ownership | Nonce/path/root/snapshot/worktree inode checks, fenced reservation/access and audit rollback. Cleanup refuses unrecorded, substituted and recreated directories. |
| P05-05: unsafe paths | Included source symlinks, metadata escape/override conditions, source/private Git locks, local Git filter overrides and runtime symlink creation refuse execution/capture. Unsafe filter test confirms its command never executes. |
| P05-06: dirty source | Existing actual-Git dirty/untracked/ignored-source preservation regressions pass; new archive/cleanup and SIGKILL fixtures independently confirm the original human file bytes remain untouched. |
| P05-07: budgets/health | Actual Linux disk/memory sampling; controlled low disk/memory policy checks; actual worker RSS/CPU/wall violations reap the owned group; a fast disk writer fails the final check; recorded health and existing queue concurrency checks pass. |
| P05-08: orphan recovery | Controller killed after a real workspace edit through the installed SDK/controlled executable. Its group exits, dead-owner reconciliation blocks the task, recorded output survives, unknown/unarchived/blocked cleanup is refused, then explicit archive/review/cancel permits guarded cleanup. |
| P05-09: retained artifacts | Full file tree packages retain ignored/new files and exact bytes. Git bundle is cloned after cleanup and restores the committed edit. Post-archive worktree edits, snapshot edits and new Git references refuse deletion until archived again. |
| P05-10: fault cases | Git lock conflicts, cancellation between creation stages, interrupted cleanup, repeated cleanup, recreated human paths and command session parent-loss tests pass. |

The four Phase 05 exit gates are proven by these fixtures: original human edits preserved; two actual concurrent controlled-SDK tasks receive distinct worktree paths/inodes and cannot acquire another task's workspace; SIGKILL leaves recoverable artifacts and no live process in the tested owned groups; cleanup rejects unowned/unarchived content. Normal harness success remains a blocked engineering-verification handoff, not task completion.

## Open risks / limitations

- Linux/POSIX process groups are the verified ownership boundary. Sampled limits are not hard cgroup/VM quotas or a malicious same-user isolation boundary. Processes deliberately escaping their group require stronger OS containment; no such guarantee is claimed. CPU accounting covers observed process deltas, not children whose entire lifetime occurs between samples; RSS sums may count shared pages more than once.
- Tree archives are bounded to **10 MiB of file bytes and 10,000 entries per tree**; Git bundles retain the existing **16 MiB** artifact cap. Oversized archives retain the workspace. Partial creation without a complete archive is retained for inspection. Seven-day retention is the default; owner configuration can change it.
- Binary tree packages and bundles intentionally preserve exact bytes without a text-redaction or secret-scanner claim. Existing private artifact permissions/limits apply. Required secret/security checks remain Phase 06 work.
- Existing projects need explicit owner identity binding after migration; replaced inodes are never silently rebound. Pre-Phase-05 workspaces and restored absolute workspace paths are not automatically adopted or deleted. Their archived artifacts remain available for explicit recovery.
- No live provider smoke was rerun; Phase 04's real-provider evidence remains historical. Docker/Postgres and other live suites remain opt-in. The current gate uses deterministic installed-SDK fixtures plus actual filesystem, process, Git, resource and failure behavior.
- CLI/OpenTUI still use the preserved legacy runner. Daemon/client integration, ordinary required verification, unattended endurance and release readiness remain later phases.

## Phase gate

**PASS for the tested Linux Phase 05 gate.** All ten engineering tasks and four explicit fixture exit gates have corresponding passing evidence. This does not complete the master roadmap or establish production/unattended readiness.

## Suggested next phase

**Phase 06 — Verification gates, evidence, and security fallback.** Replace the ordinary task's blocked verification handoff with independently enforced required checks and truthful security availability, preserving the new ownership/resource invariants.
