# Milestone 3 operations

Use a local Docker daemon whose bind mounts refer to the same filesystem as the CLI. Do not use a remote Docker context: the task worktree and private Git metadata must exist on the daemon host. The runtime needs permission to inspect/create/remove its labeled networks and containers. It does not start privileged daemons, mount Docker sockets into workloads, or change host Docker permissions.

Preload `node:22-bookworm-slim` and `postgres:16-bookworm` through your approved image workflow, or explicitly pass `--allow-image-pull`. Default verification has no external network access. If dependency recovery is desired, opt into `--allow-dependency-install`; a frozen lockfile is required. Prebuilt images should contain other language runtimes, build tools, and browsers needed by the repository.

Run deterministic verification:

```sh
pnpm test
pnpm typecheck
```

Run the real PostgreSQL acceptance test:

```sh
pnpm test:docker
# Or explicitly allow image downloads:
HARNESS_ALLOW_IMAGE_PULL=1 pnpm test:docker
```

The fixture initially has no database service. Its test must fail with a PostgreSQL connection/DNS error, the manager must provision and health-check disposable PostgreSQL, then build and application migration/write/read tests must pass. The test requires both the original failure log and passing rerun evidence. Resources are removed afterwards; the private worktree and report remain under the printed task paths. No model call is needed for this environment-specific acceptance fixture.

If Docker reports socket permission denial, daemon unavailability, missing cached images, or mount failures, inspect `report.json`, `events.jsonl`, and `harness logs`. Restore Docker access or preload the images through your environment administrator, then submit a new task. A terminal blocked task is not silently reset by `resume`. Do not switch to a simulated driver and describe that result as live PostgreSQL verification.

SDK acceptance remains separate: `pnpm test:live` uses real Codex with explicit host verification and consumes tokens. The ordinary suite uses deterministic agents and simulated Docker; live tests are explicitly skipped there.

After a process crash, wait for the lease to expire and use `harness resume <id>`. Completed turns/checks are reused; unknown coding, command, or recovery outcomes block for manual inspection. Managed resource identity is recorded before provisioning. Only matching task/purpose labels allow adoption or removal. Cleanup errors remain in the report; resuming a terminal task retries pending cleanup without rerunning coding/tests. Never run a broad Docker prune as task recovery.

Keep the SQLite database with its WAL/SHM companions when backing up active tasks. Schema version 2 adds resource status/data columns while preserving version 1 records. Existing tasks without environment state keep host execution semantics. Keep each retained worktree together with its sibling `snapshot/.git`; moving or deleting the snapshot invalidates the worktree's Git metadata.
