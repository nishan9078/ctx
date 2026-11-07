# Phase P08 Implementation Report

## Goal

CTX stays reachable while expensive agents are idle.

## Changes

- Added the lightweight Sentinel entry in `apps/daemon`, independent of CLI/UI connections. It reuses the existing supervised Codex scheduler and durable queue rather than invoking a model while idle.
- Added a bounded, versioned Unix-socket API with owner-private directory/socket/token authentication, fixed local CLI identity, submission deduplication, status/query, revision-checked task controls and shutdown. Outbox delivery is intentionally deferred to Phase 09.
- Added deadline rehydration and a bounded 30-second fallback poll for out-of-band changes. Observable states are SENTINEL_IDLE, EXECUTING, WAITING_CAPACITY and PAUSED. Held durable leases conservatively report executing until reconciled.
- Added detached `ctx daemon start|stop|status|query|submit|pause|resume|cancel|retry` and `ctx doctor --database`. A kernel flock serializes startup/restart; stale owner sockets are removed only under that lock. Shutdown stops claims, cancels/awaits workers and retains durable interrupted state before closing the repository.
- Added the systemd user-unit template, resource/restart/log settings and [daemon runbook](../../DAEMON.md). [ADR-012](../../decisions/ADR-012-sentinel-ipc.md) records the IPC/lifecycle policy. No schema, dependency or adapter version changed. Implementation commit: `4ca8f82`.

## Verification performed

Development Node 22.22.1; bundled Node 26.4.0. Fake inference workers are explicitly restricted to fixture projects in tests. Local IPC, filesystem/Git, CLI process lifetime, SIGKILL/restart, kernel locks and the temporary user service are real local execution. No live model generation or external notification was performed.

| Command | Exit code | Result |
|---|---:|---|
| `pnpm typecheck` | 0 | `typecheck.log` |
| `pnpm build` | 0 | Final source build; `build.log` |
| `pnpm check:boundaries` | 0 | New daemon boundary remains acyclic; `boundaries.log` |
| `pnpm test` | 0 | **321 passed, 6 existing opt-in skips**; `regressions.log`. Before final held-lease observable-state adjustment, covered below. |
| `node --test dist/tests/integration/sentinel.test.js` | 0 | **5 passed**; final state/lock and lifecycle checks; `final-focused.log` |
| `releases/ctx-linux-x64/runtime/bin/node --test --test-reporter=tap dist/tests/integration/sentinel.test.js` | 0 | **5 passed**, no skips; `bundled-runtime.log` |
| `systemd-analyze --user verify deploy/systemd/ctxd.service` | 0 | Unit validates; unrelated installed spice-vdagent unit warning retained in `unit-verify.log`. |
| `node scripts/test-sentinel-service.mjs` | 0 | Temporary real user service starts/restarts/stops, PID changes, paused state survives, zero inference workers; `service.log`. |

The initial focused run exposed an ingress-label defect (`local` versus the repository's required `cli` source); the implementation was corrected without weakening validation. `initial-focused-failure.log` retains that evidence. The restricted context denied access to the user-service bus; authorized read-only inspection showed it running. A uniquely named disposable transient service was then tested and stopped. No permanent unit was installed and no lingering, login, hardware or global setting changed.

## Acceptance evidence

- Idle authenticated submit wakes a controlled worker with no interactive UI. Incorrect credentials are rejected before submission; token/socket permissions are private.
- Client disconnect after acknowledgement does not stop execution. Exact repeated submission returns the existing task; idle returns with zero active workers and one attempt.
- Capacity deadline and outbox IDs survive repository close/reopen and daemon restart; no worker starts before the persisted deadline.
- Active shutdown awaits cancellation and records an interrupted attempt; it never claims unfinished work completed.
- Detached CLI process exits while its daemon remains available. A second kernel-lock contender cannot execute. SIGKILL followed by restart preserves a queued task, outbox and pause state. CLI stop shuts down the managed daemon.
- Actual temporary systemd restart preserves paused state with no inference worker. The provided unit is statically validated; it is not installed as a permanent user service.
- Final focused coverage includes conservative EXECUTING status for a held durable lease even when the new daemon has no local worker yet.

## Open risks / limitations

- **P08-08 remains partially verified:** real user-service restart is tested, but actual OS logout/re-login is not performed in the user's active session. Detached client exit is tested separately and is not described as OS logout. No lingering policy was changed. This remaining acceptance item stays unchecked in the roadmap.
- Laptop suspend prevents execution until resume. Lingering does not provide hardware wake, network availability or awake CPU time. These limits and owner installation choices are documented in the runbook.
- No fresh live Codex inference, real provider recovery, external outbox delivery or Discord integration was run. Existing owned-group lifecycle regression coverage is retained; daemon fixtures use deterministic workers. Live M1 acceptance remains required before Discord.
- Authentication trusts the owning OS user. Same-user compromise is outside that boundary. Unix socket path-length limits apply; use a short private data directory.
- The existing interactive runner retains its legacy execution path. New clients can use Sentinel IPC without owning worker lifetime; a full TUI migration is not claimed.
- Production daemon recovery is not silently enabled: Phase 07 remains explicit scheduler configuration. Query responses are limited to the first 100 tasks/outbox items; broader pagination is later work.

## Phase gate

**PASS — four local daemon exit checks. Full Phase 08 signoff remains pending P08-08 actual OS logout/re-login acceptance.** Final focused validation passes on both runtimes; client disconnect and service restart are tested separately from OS logout.

## Suggested next phase

Close the remaining owner-session logout/re-login acceptance when an appropriate session is available. Phase 09 is Discord remote control, approvals and notification delivery, gated by the separate live M1 demonstration. No Discord setup or messaging was started.
