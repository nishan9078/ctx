# Phase P06 Implementation Report

## Goal

CTX has a reliable, auditable definition of completion.

## Changes

- Schema **7** preserves historical verification records and adds immutable owner profiles, per-attempt profile/spec bindings, scoped waiver grants, full statuses/step metadata and verification process identities. Historical v4/v5/v6 migration fixtures execute the original migration sequence rather than relabeling a current database.
- Ordinary Codex queue completion runs independent gates from a frozen profile: scope, test/script/protected-file integrity, secrets, syntax, dependency checks and exact configured typecheck/test/build/lint/scan commands. No agent-generated command becomes verification policy. Required test evidence proves a configured positive minimum with no skipped/cancelled/todo/deselected cases.
- Per-step deadlines, sampled operational budgets, restricted command environments and owned process groups supervise controller-launched checks. Unavailable Docker/backend/scanner coverage never silently falls back to a passing host command. Source/integrity/secret guards run after all commands and detect verifier source mutation.
- The fenced completion transaction requires matching immutable report/evidence, successful harness proof, a retained private result commit and archived workspace, plus exact owner waiver consumption where applicable. Cancellation wins. A completed harness attempt can still leave its task blocked when verification is unavailable/mock-only.
- Existing Codex Security is opt-in and budgeted. Independent syntax/credential-pattern/npm-advisory baseline checks retain explicit coverage limitations. Unsupported dependency coverage stays unavailable or uses an owner-configured required scanner command.
- Each finished ordinary attempt receives `report.json` and `REPORT.md` with structured observations, timings, environment, findings, log references, frozen hashes and deliverable identity. Confirmed-dead historical report repair retains partial evidence and records nonexecution without replay or inferred completion.
- CLI adds `profile`, `waive` and `details --report-format json|markdown` for an existing V1 database. Details verify evidence hashes before display. See [the execution/report contract](../../architecture/verification-gates.md) and [ADR-010](../../decisions/ADR-010-verification-profiles.md).

Feature commits: `94774bf` freezes owner-defined profile/waiver contracts; `00d7027` adds independent execution, completion, CLI and failure-injection tests. No SDK, CLI, dependency or adapter version upgrade was introduced.

## Verification performed

Development Node **22.22.1**, pnpm **12.16.1**; bundled Node **26.4.0**. Commands below use authorized local execution for real subprocess checks: the known restricted context suppresses Node child output. No check, global setting or sandbox policy was weakened.

| Command | Exit code | Result |
|---|---:|---|
| `node --test dist/tests/integration/codex-persistence.test.js dist/tests/integration/migrations.test.js dist/tests/integration/verification-registry.test.js dist/tests/integration/workspace-registry.test.js` (foundation) | 0 | 18 passed; `profile-contracts.log`. |
| `pnpm test` (foundation) | 0 | 288 passed, 6 existing opt-in skips; `profile-regressions.log`. |
| `pnpm typecheck` | 0 | `typecheck.log`. |
| `pnpm build` | 0 | `build.log`. |
| `pnpm check:boundaries` | 0 | `boundaries.log`. |
| `pnpm test` | 0 | **310 passed, 6 existing opt-in skips** (316 total), `regressions.log`. |
| `releases/ctx-linux-x64/runtime/bin/node --test --test-reporter=tap dist/tests/unit/profile-checks.test.js dist/tests/integration/verification-registry.test.js dist/tests/integration/verification-details.test.js dist/tests/integration/engineering-gates.test.js` | 0 | **26 passed**, no skips, `bundled-runtime.log`. |

## Acceptance evidence

- **Controlled harness; real local tools:** generated disposable Node repo begins with failing `add(2,3)` behavior. The fake SDK stream claims done; the real compiler, TAP tests, build, lint, baseline scanners and final guards independently decide completion. Passing work retains an exact private Git result commit, binary tree/Git archive, stdout/stderr and both reports. Original project bytes stay unchanged.
- **Failure injection:** wrong types, wrong behavior, failing build, credential finding, changed/skipped tests and out-of-scope files prevent task completion despite the same agent success claim. Timeout tests require owned groups to be dead. A verifier that changes source after passing tests fails the final guard.
- **Exact configured gates:** immutable profile tests reject mutation, omitted guards, unsupported shell commands and test gates without count evidence. Reports with missing configured checks are rejected, including failed/interrupted harness reports.
- **Unavailable vs approved exceptions:** required disabled Codex Security blocks despite passing independent baseline checks. An exact pre-attempt owner waiver preserves the observed unavailable result, is visible as `skipped_with_approval` and is consumed only by that attempt. Optional unavailable service coverage stays visible without being called passed.
- **Mock coverage:** injected mock project commands report `mock_verified` and explicitly state live integration untested; required mock results block completion. No mock is substituted for live provider/scanner evidence.
- **Reporting/integrity:** CLI round trips register/freeze/waive/report metadata and hashes; corrupted evidence fails display. Completion boundary tests inject cancellation and artifact corruption after a passing report. Historical recovery creates nonpassing reports once, only after quiescence, without project/model replay or retroactive profile invention.

## Open risks / limitations

- **Live provider/scanner coverage:** no new live paid Codex generation, Codex Security call, production operation, deployment or credentials were used. The existing Phase 04 live queue evidence remains valid for its own adapter/handoff contract; the new complete Phase 06 slice is demonstrated with a controlled harness and real local verification. A fresh live end-to-end M1 demonstration remains untested.
- **Isolation/platform:** tested Linux supervision and sampled limits are not a VM/cgroup sandbox. Host profiles authorize project code execution on the host. Docker project-command execution requires an explicitly supplied backend; unavailable configuration blocks. macOS execution is unverified; the preserved legacy syntax-check default keeps its prior process backend.
- **Security scope:** secret/omission patterns are incomplete; protect project-specific test helpers/configuration in profiles. The offline dependency baseline supports root npm lock records and owner-supplied exact advisories, not all ecosystems or a current online feed. Unknown coverage remains unavailable. Private binary evidence may contain original secrets and is intentionally not redacted.
- **Recovery scope:** live/unobservable process groups block release/report repair. Historical requirements that were never bound stay unknown. Missing/corrupt storage evidence cannot establish completion. General resumable recovery and bounded retries remain Phase 07.
- **Product/release scope:** CLI/OpenTUI legacy execution and fixture-only records remain separate contracts. The unattended supervisor, remote ingress, UI integration, nightly operation and release gates remain unfinished. Do not infer overall M1 live certification or production readiness.

## Phase gate

**PASS — tested Phase 06 Linux contract.** All ten engineering tasks and five phase exit checks have deterministic acceptance evidence; real local verification tools establish the outcomes. No fresh live provider/scanner or full unattended/release certification is claimed. Live M1 demonstration remains explicitly untested.

## Suggested next phase

**Phase 07 — Recovery engine, resumable work, and bounded retries**, depending on retained Phase 06 report/profile/workspace identity and exact verification outcomes. Do not start Discord before the required M1 vertical slice and its live demonstration are accepted.
