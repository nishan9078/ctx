# Phase P00 Implementation Report

Date: 2026-11-06. Scope: roadmap Phase 00 only.

## Goal

Understand what exists before introducing a new architecture.

## Changes

- Preserved baseline commit `486aa44720de928cffda8b080681f26867045d0a` in `checkpoint/pre-roadmap-audit-20261106`; created `roadmap/p00-baseline-audit` for this work. Initial worktree was clean.
- Added `CURRENT_STATE.md`, `docs/architecture/current-state.md`, `docs/decisions/ADR-000-baseline.md`, repository instructions in `AGENTS.md`, and this evidence directory.
- Added `.node-version` selecting tested core/development Node 22.22.1. Preserved the existing separate Node 26.4.0 OpenTUI runtime.
- Pinned the already installed `@types/node` 22.20.5 and `tsx` 4.23.15 in `package.json` and `pnpm-lock.yaml`. No resolved dependency version changed.
- Inventory, dependency graph, retain/refactor/replace/defer map, prioritized debt and Phase 01 file/test map are in the audit. Existing implementation, tests, release bundles and historical evidence were preserved.
- Recorded Phase 00 checklist completion and the qualified gate in the master roadmap; later phase checklists remain unchanged. A new untracked user audio file appeared during the audit and was left untouched.

## Verification performed

Run these from `/home/nishan/ctx`, with the pinned Node version and pnpm 12.16.1. Authorized host execution means approval to run outside this session's filesystem/subprocess sandbox; it does not mean workers run privileged. Frozen install used the existing local cache; an empty-cache/network install was not tested.

| Exact command | Exit | Result / evidence |
| --- | ---: | --- |
| `pnpm install --frozen-lockfile --offline` | 0 initially, 1 on restricted repeat | First invocation succeeded; repeated store-lock access was denied on read-only filesystem. Failure retained in `install.log`. |
| `pnpm install --offline` (authorized, after exact pins) | 0 | Existing dependencies up to date; `install-pin.log`. |
| `pnpm install --frozen-lockfile --offline` (authorized, final pins) | 0 | Lockfile matches; `install-authorized.log`. |
| `pnpm typecheck` | 0 | Strict TypeScript check; `typecheck.log`. |
| `pnpm build` | 0 | Compiler build; `build.log`. `pnpm test` and `test:tui` also rebuild. |
| `pnpm test` (restricted) | 1 | 16 file-level passes, six failing integration files; `test.log`. This output is not the individual test count. |
| `node --test --test-reporter=tap dist/tests/integration/process.test.js dist/tests/integration/loop.test.js` (restricted) | 1 | Reproduced failure; `failure-detail.log`. |
| `node dist/tests/integration/process.test.js` (restricted) | 1 | Empty captured child output causes `Unexpected end of JSON input`; `process-direct.log`. |
| `pnpm test` (authorized) | 0 | **118 tests: 113 passed, five opt-in live tests skipped, zero failures**; `test-authorized.log`. |
| `pnpm test:tui` | 0 | Four native renderer tests passed using existing bundled Node 26.4.0; `tui.log`. |
| `node dist/apps/cli/src/index.js doctor` (restricted) | 1 | Docker unavailable to sandboxed Node child; `doctor.log`. |
| `node dist/apps/cli/src/index.js doctor` (authorized) | 0 | Git, Docker, execution engine, account, security engine import and Python ready; scan access explicitly not checked; `doctor-authorized.log`. |
| `pnpm test:docker` (authorized; pulls disabled) | 1 | PostgreSQL fixture image absent. Correct `blocked` task, no agent turn; `docker-live.log`. |
| `opencode --version` (restricted, then authorized) | 1, then 0 | Normal log path was read-only; approved version probe reports **opencode v2.2.5**. No OpenCode task/model access tested. |

The restricted failures were `engineering`, `environment`, `loop`, `process`, `terminal`, and `verification-plan` integration files. The passing authorized run of the same suite isolates this as a session execution limitation; no test was changed. Docker's restricted diagnostic explicitly identifies a restricted user namespace. Do not weaken `runProcess` or socket policy to make restricted checks pass.

Local tool/SDK probes and source inventory are retained in `versions.json` and `inventory.json`. Version probes verify locally installed interfaces only. Codex login status in doctor establishes account readiness without making a generation call. No real model task, live security scan, image download or global configuration change was performed.

## Acceptance evidence

| Roadmap item | Evidence |
| --- | --- |
| P00-01 | Audit inventory/ownership table, inventory JSON, root scripts and inspected CLI/TUI modules. |
| P00-02 | Source import graph; runtime core/persistence cycle; type coupling; synchronous SQLite/artifact reads and UI-owned execution documented. |
| P00-03 | Install/typecheck/build/test/native UI logs above; authorized baseline reproducible with existing dependencies. |
| P00-04 | Current Docker preflight and real fixture failure classified below; ordinary tests pass without Docker live acceptance. |
| P00-05 | Version probes, OpenCode result, SQLite embedded version and runtime split in audit/ADR. |
| P00-06 | Actual `CodexSecurity.run` implementation inspected; injected adapter tests separated from unverified live scan access. |
| P00-07 | Per-package retain/refactor/replace/defer recommendations in audit. |
| P00-08 | Checkpoint and work branches, clean initial worktree; no deletion of existing code/tests/evidence. |
| P00-09 | Architecture audit, ADR-000, root current-state pointer, report and machine-readable inventory. |
| P00-10 | `.node-version`, exact dependency specs and matching frozen lockfile; no SDK upgrades. |

## Open risks / limitations

**P00-ENV-01 — optional Docker fixture prerequisite:** Authorized Docker access now succeeds, unlike historical stale-group evidence. The acceptance test fails because `postgres:16-bookworm` is not installed and pull permission defaults to false. Its report is `.harness/docker-live/c853a3d3-d572-4c5d-bab8-cb5a0e89de95/report.json`; outcome is `blocked`, agent turns zero. Before retry, an operator must approve/preload the fixture images (`postgres:16-bookworm` and configured application image, default `node:22-bookworm-slim`) through normal infrastructure policy. Then rerun `pnpm test:docker`; alternatively explicitly authorize `HARNESS_ALLOW_IMAGE_PULL=1 pnpm test:docker`. Do not remove foreign containers, modify socket permissions or convert the failed check into mocked success. This is a tracked prerequisite, not a product baseline failure or a claim of live PostgreSQL coverage.

Five skipped live cases remain unverified in this audit. General security scanning, provider quotas/entitlements, macOS operation, real service/logout/suspend behavior, empty-cache installation and release packaging were not demonstrated. These do not block the Phase 00 code audit but remain requirements for the relevant later gates.

## Phase gate

**PASS**, under Phase 00's explicit allowance for a documented optional Docker failure with remediation. Reproducible ordinary build/tests are usable in authorized execution, broken checks are classified and retained, prior code and user state are preserved, and the Phase 01 map identifies existing modules and expected changes. This does not mean MVP or V1 is complete.

## Suggested next phase

**P01 — Core domain contracts, package boundaries, and configuration.** Use the implementation map in the audit; create a separate phase branch. Keep schema/queue/daemon changes in their later phases.
