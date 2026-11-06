# ADR-000: Preserve and extend the existing runner

Date: 2026-11-06. Status: accepted for the first implementation cycle.

## Context

The master roadmap defines the intended product. Commit `486aa44720de928cffda8b080681f26867045d0a` provides a functioning single-task runner, not a demonstrated V1 supervisor. Replacing it would discard tested verification, isolation, recovery, and terminal behavior.

## Decisions

- Retain TypeScript strict mode, the existing workspace layout, and pnpm 12.16.1. Internal imports currently cross package boundaries by relative source paths; formal package exports can follow stable contracts.
- Pin the development/core baseline with `.node-version` to **22.22.1**, the locally tested runtime. Keep the existing `engines >=22.13` declaration as a compatibility floor, not evidence that every matching version works. Node SQLite remains experimental on the tested runtime.
- Preserve the separate **26.4.0** bundled runtime for OpenTUI's Node FFI support. `scripts/start-ctx.mjs`, `scripts/test-tui.mjs`, and release packaging already select it. Core checks on Node 22 do not prove native UI support on Node 22. Packaging currently supports Linux x64/arm64; macOS is an unfulfilled roadmap target.
- Pin `@types/node` to 22.20.5 and `tsx` to 4.23.15, matching the existing installed/locked versions. Retain all six exact production dependency versions and the full pnpm lockfile; introduce no SDK upgrade during the audit.
- Retain SQLite WAL and local per-task leases. Extend schema through versioned migrations in Phase 02; do not treat the current schema as the roadmap schema.
- Retain private Git snapshot/worktree isolation. Existing snapshots preserve dirty/untracked source files without modifying source Git metadata. Future registered-project/task-branch and integration policy must account for this existing behavior.
- Retain the SDK-first Codex adapter (0.166.0), its cancellation signal, session resume, and restricted worker options. Keep scheduler policy independent of that API. No App Server migration is justified by this audit.
- Sentinel must be ordinary software with no idle LLM. Its command ingress and scheduler ownership are future phases. CLI/TUI currently own execution; they must eventually become clients.
- Keep Codex Security optional. SDK import/readiness is not evidence of account entitlement or scan coverage. Required deterministic security commands must remain required; unavailable scanning cannot establish a pass.

## Consequences

Phase 01 can establish neutral domain contracts and command boundaries while preserving the runner. It must break the current core/persistence runtime dependency cycle and shared/verification type coupling deliberately, with regression coverage. No schema/state rename should be applied to existing JSON task records without a compatibility plan.

The baseline test suite passes in authorized host execution. Restricted subprocess execution fails six integration files; both runs are retained. The optional Docker acceptance test is currently blocked by a missing fixture image (P00-ENV-01), not stale groups in the authorized context. No model generation, live security scan, image download, deployment, or global machine configuration change was performed.
