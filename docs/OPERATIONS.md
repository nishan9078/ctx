# Milestone 3 operations

For versioned state/evidence backups and clean-directory restores, see [Backup and restore](BACKUP_RESTORE.md). Historical execution troubleshooting below remains a record of the prototype environment.

Use a local Docker daemon whose bind mounts refer to the same filesystem as the CLI. Do not use a remote Docker context: the task worktree and private Git metadata must exist on the daemon host. The runtime needs permission to inspect/create/remove its labeled networks and containers. It does not start privileged daemons, mount Docker sockets into workloads, or change host Docker permissions.

Preload **both** `node:22-bookworm-slim` and `postgres:16-bookworm` through your approved image workflow, or explicitly pass `--allow-image-pull`. With that permission, missing images are pulled and inspected again before coding or network/container creation. Socket/daemon inspection errors are not treated as cache misses and never trigger automatic permission changes or image pulls. Default verification has no external network access. If dependency recovery is desired, opt into `--allow-dependency-install`; a frozen lockfile is required. Prebuilt images should contain other language runtimes, build tools, and browsers needed by the repository.

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

## Distinguish the running session from account configuration

Run these diagnostics in the **same execution context that starts the orchestrator**:

```sh
id -G                         # groups held by this running session
id -G "$(id -un)"              # groups configured for the account
stat -Lc 'owner=%u group=%g mode=%a' /var/run/docker.sock
docker info --format '{{.ServerVersion}}'
```

If the account includes the socket group but the running session does not, the runner has stale supplementary groups. The account is already authorized; adding it again or changing socket permissions will not repair that process. Log out and back in, completely stop the long-running terminal/Codex application and its backend, then launch it from the refreshed login session. Starting another shell from the old application still inherits the old groups. This follows [Docker's login-session guidance](https://docs.docker.com/engine/install/linux-postinstall/).

For this repository's investigated failure, the socket was `root:docker`, GID 973, mode 660. The account database included `nishan` in GID 973, while the non-sandboxed runner and its Node/Docker children lacked 973. Direct and detached child Docker commands failed identically. This established a stale runner session, rather than loss of groups in the harness's subprocess implementation. Earlier reports that reached image inspection came from a context with daemon access; they do not establish access for a later process.

If membership is genuinely absent, an administrator must authorize the runner's account for the approved daemon (or configure an approved rootless endpoint). For a service-managed runner, the administrator must refresh/restart that service with its intended supplementary groups. Do not run the harness under `sudo`, invoke `newgrp` inside it, or make the socket world-writable as automatic recovery. Docker access is powerful; the orchestrator belongs in an explicitly authorized control-plane context, while coding/verification workloads remain sandboxed without the Docker socket.

The Docker driver preserves the runner's UID/GID/supplementary groups and snapshots its inherited environment, including `DOCKER_HOST`, `DOCKER_CONTEXT`, `DOCKER_CONFIG`, TLS selectors and proxies. It does not reset the context, read credential files for diagnostics, or select a more privileged process on failure. Child processes cannot acquire a supplementary group merely because it was added to the account database after the runner started.

Permission failures now retain non-secret process/socket facts and a recommendation in `environment/docker-diagnostics.json`, the event journal, and the report. Restricted user namespaces are identified separately from stale account groups. A Docker infrastructure failure during verification is recorded as an unavailable check and blocks the task without spending model repair attempts. Container startup errors (Docker exit 125) likewise block; a successful `docker info` alone does not prove workload or PostgreSQL health.

After refreshing the session, confirm access and the image cache before the live test:

```sh
docker info --format '{{.ServerVersion}}'
docker image inspect node:22-bookworm-slim postgres:16-bookworm --format '{{.RepoTags}}'
pnpm build && HARNESS_DOCKER=1 node --test dist/tests/integration/docker-live.test.js
```

If a required image is absent, preload that exact image through the approved workflow or run `HARNESS_ALLOW_IMAGE_PULL=1 pnpm test:docker` to explicitly permit provisioning. A Node image in cache does not imply the PostgreSQL image is present. Neither a skipped test nor a blocked diagnostic report counts as passing live acceptance.

SDK acceptance remains separate: `pnpm test:live` uses real Codex with explicit host verification and consumes tokens. The ordinary suite uses deterministic agents and simulated Docker; live tests are explicitly skipped there.

After a process crash, wait for the lease to expire and use `harness resume <id>`. Completed turns/checks are reused; unknown coding, command, or recovery outcomes block for manual inspection. Managed resource identity is recorded before provisioning. Only matching task/purpose labels allow adoption or removal. Cleanup errors remain in the report; resuming a terminal task retries pending cleanup without rerunning coding/tests. Never run a broad Docker prune as task recovery.

Keep the SQLite database with its WAL/SHM companions when backing up active tasks. Schema version 2 adds resource status/data columns while preserving version 1 records. Existing tasks without environment state keep host execution semantics. Keep each retained worktree together with its sibling `snapshot/.git`; moving or deleting the snapshot invalidates the worktree's Git metadata.
