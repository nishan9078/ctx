# Independent queue verification

Ordinary queue tasks use `createCodexQueueScheduler` and its engineering result pipeline. The preserved legacy single-task runner and fixture-only scheduler keep their separate contracts. An SDK completed turn is necessary, but ordinary task completion also requires independent verification, matching retained evidence and a fenced transaction. The scheduler itself has no provider event knowledge.

The owner registers a normalized, immutable profile before execution. An attempt freezes the exact project/profile hash and specification hash before harness work. Missing profiles remain unavailable for that attempt. Scope, test integrity and secrets are required independent checks; code profiles also require syntax, tests and dependency coverage. New requirements use a new profile ID. Commands use exact argv from the owner profile, not agent suggestions or modified package scripts. Existing tests and owner-protected inputs cannot change; new tests are permitted. Protect project-specific test configuration and helper inputs explicitly.

`backend: "host"` explicitly authorizes project commands on the host in a private worktree with a private HOME and a restricted environment. This is not a security sandbox. Default command execution is refused for `none` and for `docker` without an explicitly supplied backend; no host fallback occurs. Controller-launched syntax tools, project commands and Codex Security processes retain observable owned process-group identities, sampled resource budgets, per-step deadlines and quiescence requirements. An injected backend is trusted implementation code responsible for its own execution isolation and signal handling; mock results cannot prove live coverage.

Each configured check produces status, observed status, exact command, environment, timing, exit code, findings, limitations and immutable stdout/stderr artifact references. TAP/pytest test summaries must prove a positive configured minimum and no omissions. Summaries are checked again from immutable evidence before finalization. Scope, test integrity and secret guards run again after commands; verification cannot mutate deliverable source outside approved generated outputs. Passing work is committed on its private task branch and archived with exact bytes and a Git bundle before completion. Cancellation wins the completion transaction; every required check must pass or have an exact recorded owner waiver.

Waivers bind profile owner, task specification, profile hash, step, next attempt sequence and expiry (at most 24 hours). Grant them before the attempt and only for explicitly waivable checks. Scope and test-integrity guards cannot be waived. Observed failures/unavailability remain visible under `skipped_with_approval`; successful completion consumes the grant transactionally. Waivers do not make mocked or unexecuted integration live.

## Security coverage

The existing Codex Security adapter is reused only with explicit profile opt-in and a bounded scanner budget. Disabled, missing, unavailable, interrupted and mocked scans stay distinct from passed scans. Independent baseline checks include trusted syntax parsing, suspicious credential patterns/known environment-secret values, and an offline dependency scan. Findings never include secret values. Exact private binary archives are not redacted.

The dependency baseline supports a root npm manifest and package-lock package records against an owner-supplied exact-version advisory snapshot. No dependency installation or network advisory query occurs. Unsupported/nested ecosystems, missing lock versions and missing advisory coverage report unavailable. Projects may configure a required `dependencies` command with role `scan` for an approved external scanner instead. An empty or stale owner snapshot proves only that declared coverage, not current vulnerability absence. Secret and omission patterns similarly provide limited detection, not semantic completeness.

## Reports and CLI

A finished ordinary attempt publishes protected `data/verification/<attempt>/<run>/report.json` and `REPORT.md` files and their hash-bound managed artifact copies. SQLite stores immutable structured runs/steps. Reports identify base/result commits, archived workspace hash, frozen gates, harness proof and all evidence references. Task disposition remains authoritative in task details: a passing check report cannot override cancellation.

```sh
node dist/apps/cli/src/index.js profile profile.json --project PROJECT --database /path/state.sqlite
node dist/apps/cli/src/index.js details TASK --database /path/state.sqlite
node dist/apps/cli/src/index.js details TASK --database /path/state.sqlite --report-format markdown
node dist/apps/cli/src/index.js waive TASK --step scanner --revision 3 --reason 'Exact one-attempt exception' --expires 2026-11-07T20:00:00Z --database /path/state.sqlite
```

CLI registration and waivers use the same local UID principal. Remote ingress must authenticate and authorize its principal before calling these APIs. `details` verifies stored artifact hashes and identities before printing report evidence; corruption fails rather than printing a green summary. It exposes historical completion without treating a consumed waiver's later expiry as a retroactive failure.

Scheduler startup/idle reconciliation can create missing historical incident reports only after all old owned groups are confirmed dead and the task has no active attempt. It retains partial evidence, marks checks not run and never replays model/project execution or establishes completion. Unknown historical requirements remain unknown; profiles registered later are never applied retroactively. Task-scoped repair artifacts distinguish recovery evidence from original attempt output. An unobservable or live group blocks report repair. Fixture-only historical records retain their existing explicit mock contract.

See [Phase 06 verification evidence](../verification/phase-06/REPORT.md) for actual coverage and remaining live limitations.
