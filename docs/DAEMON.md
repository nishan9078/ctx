# Running Sentinel

Sentinel is a lightweight local listener and scheduler. It opens the existing V1 database, reconciles retained attempts/reports, wakes on submissions and stored deadlines, and keeps IPC available while inference workers are idle. It performs no LLM polling. One daemon owns a data directory through the Linux `flock` kernel lock. Use a separate data directory for each database.

Build with `pnpm build`. Register the project and immutable verification profile using the existing owner APIs/CLI before submitting ordinary work. No fixture worker is enabled in the production daemon. The daemon uses the existing supervised Codex queue factory; recovery remains opt-in at its API and is not enabled by this launcher.

```sh
node dist/apps/cli/src/index.js daemon start --database /absolute/data/state.sqlite
node dist/apps/cli/src/index.js daemon status --database /absolute/data/state.sqlite
node dist/apps/cli/src/index.js doctor --database /absolute/data/state.sqlite
node dist/apps/cli/src/index.js daemon submit submission.json --database /absolute/data/state.sqlite
node dist/apps/cli/src/index.js daemon query --database /absolute/data/state.sqlite
node dist/apps/cli/src/index.js daemon cancel TASK --revision 3 --database /absolute/data/state.sqlite
node dist/apps/cli/src/index.js daemon stop --database /absolute/data/state.sqlite
```

Submission JSON contains `spec` (the validated V1 task specification with metadata.source `cli`) and a stable `deduplicationKey`. Retrying a lost acknowledgement uses the same key. `pause`, `resume` and `retry` also require task ID and current revision. The daemon sets the authenticated principal and local notification destination; callers cannot supply a remote identity. `query` returns up to 100 tasks and pending outbox records; remote delivery is Phase 09. Existing `details` exposes hash-checked reports. CLI/TUI clients can use the exported `sentinelRequest` API without owning worker lifetime; the preserved interactive runner still has its legacy execution path.

`status` reports SENTINEL_IDLE, EXECUTING, WAITING_CAPACITY or PAUSED, local active-worker count, persisted queue state, deadlines and errors. Held durable running leases conservatively report EXECUTING until reconciliation. WAITING_CAPACITY covers persisted delayed work, including recovery deadlines. Blocked tasks remain visible in the queue while Sentinel can be idle. `stop` acknowledges shutdown initiation; the daemon cancels and awaits active work before closing the database and releasing the kernel lock. Inaccessible ownership or non-cooperative workers are not declared safely stopped merely because a timeout elapsed.

The `sentinel` directory and token are owner-only; the socket is mode 0600. Requests require the token, version 1 and bounded newline-delimited JSON. Invalid identity, oversized input and stalled clients are rejected. Tokens never appear in process arguments or responses. This protects against other OS users, not a compromised process running as the same user. Keep database/artifact parents private. Unix socket paths must fit the platform path-length limit; use a short data directory. Do not invoke the daemon entry's internal `--locked` mode without the documented flock wrapper.

## User service

`deploy/systemd/ctxd.service` provides Restart=on-failure, a five-second retry delay, owner-only umask, journal logging, process-group shutdown, a stop deadline and memory/process/file limits. It does not enable itself or change lingering. The launcher creates private IPC credentials and paths; stop a manually launched instance before enabling the unit.

Create an owner-readable `~/.config/ctx/daemon.env` containing absolute paths (use no shell substitutions):

```ini
CTX_ROOT=/absolute/path/to/ctx
CTX_DATA=/absolute/data
CTX_NODE=/absolute/path/to/node
```

After configuring those paths, preparing the database/profile and running `daemon start` then `daemon stop` once:

```sh
mkdir -p ~/.config/systemd/user
cp deploy/systemd/ctxd.service ~/.config/systemd/user/ctxd.service
systemctl --user daemon-reload
systemctl --user enable --now ctxd.service
systemctl --user status ctxd.service
journalctl --user -u ctxd.service
```

These are owner installation instructions, not actions performed by the implementation. Tune resource limits for the approved workloads. Development/core Node 22.22.1 and bundled Node 26.4.0 remain separate supported test baselines; native UI support is not inferred from daemon checks. The standalone launcher logs to the private `sentinel/daemon.log`; systemd uses the journal.

## Restart, logout and suspend

Queue timestamps, retries, pause state and outbox remain in SQLite; startup rebuilds timer wakeups from that state. The daemon also checks for out-of-band database changes at most every 30 seconds. Wall-clock changes are reconciled at the next bounded timer/poll. Expired real attempts require confirmed-dead ownership reconciliation and never replay unknown effects automatically. SIGTERM waits for supervised worker shutdown; systemd's control-group kill is the last resort after its deadline.

Closing a CLI or TUI connection does not stop the daemon. Actual user logout may stop the user service manager unless an administrator/owner explicitly enables lingering. `loginctl enable-linger USER` is a separate policy choice; it is not run by CTX. A temporary real user-service restart is tested, but actual logout/re-login and lingering have not been exercised in the user's session.

Neither a user service nor lingering keeps code running while hardware is suspended. Deadlines become eligible when the machine resumes and timers run again; no hardware wake-on-LAN or wake-from-suspend guarantee is provided. Network loss during active work follows the existing retained-evidence and reconciliation rules.
