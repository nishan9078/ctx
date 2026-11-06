# Autonomous Codex Engineering Harness

Milestones 1–3 implement request → validated plan → sequential Codex execution → build/tests → bounded repair → evidence report, with SQLite state, a transactional event journal, leases, checkpoints, Git worktrees, sandboxed Docker verification, and deterministic environment recovery. The orchestrator owns completion; an agent summary alone cannot pass a task.

Building from source requires Node.js 22.13+, pnpm 12, Git, a reachable local Docker daemon with cached runtime/service images, and configured Codex authentication. The SDK is pinned to `@openai/codex-sdk@0.166.0`; its bundled CLI uses your existing Codex login or `CODEX_API_KEY`. See the [official SDK documentation](https://developers.openai.com/codex/sdk/). Persistence uses Node's built-in [SQLite module](https://nodejs.org/download/release/latest-jod/docs/api/sqlite.html), which emits an experimental-feature warning on Node 22.

```sh
pnpm install
pnpm build
pnpm test
pnpm harness run "Add a farewell function and tests" --repo tests/fixtures/feature --allow-image-pull
```

## Download and open CTX

The release build produces `releases/ctx-linux-x64.tar.gz` and its `.sha256` file. The Linux x64 bundle includes its own Node.js runtime and production engine packages, so the destination machine does not need Node.js, pnpm, or a separate engine installation. It still needs Git, compatible glibc/libstdc++, Docker access for application checks, provider authentication, and Python 3.10+ for security scans (`tomli` is needed on Python 3.10).

```sh
sha256sum -c ctx-linux-x64.tar.gz.sha256
tar -xzf ctx-linux-x64.tar.gz
./ctx-linux-x64/ctx --repo /path/to/your/project
```

To install the `ctx` command for your account:

```sh
./install.sh
export PATH="$HOME/.local/bin:$PATH"
cd /path/to/your/project
ctx
```

The installer writes only under `~/.local` by default and requires `./install.sh --upgrade` to update an existing installation. An explicit upgrade retains backups of the previous release and launcher. `./install.sh /other/prefix` selects another destination. It does not change shell profiles, Docker permissions, or authentication. Extracting and running `./ctx` also works without installing anything.

If `ctx` still opens an old interface, inspect `command -v ctx`: a previously installed copy can differ from `releases/ctx-linux-x64/ctx`. Run the rebuilt executable directly, or update using `./releases/ctx-linux-x64/install.sh --upgrade` from the checkout. The launcher preserves the directory you launched it from as the default target repository. `/repo` changes the selected target independently of the executable location.

CTX opens its own full-screen terminal interface with a scrollable transcript, task progress, security status, and an input area. The downloadable bundle includes Node.js 26.4.0 and enables its required FFI support. Use `ctx --plain` for the line interface; redirected input selects it automatically. An unsupported interactive runtime reports an error instead of silently selecting readline. `pnpm ctx` uses the bundled runtime when available. Ctrl-C cancels active work, then exits on a second press; Page Up and Page Down scroll the transcript. Tab switches Minimal/Detailed without restarting work or losing history; the preference is saved in the selected repository’s `.harness/ui.json`. Shift-Enter or Ctrl-J adds a line; Enter sends. Ctrl-P opens the searchable command palette, F1 or `/help` opens help, and Ctrl-O inspects command output and tool events. Detailed mode shows the journal timeline, plan, verification and recovery state; `/diff` opens a scrollable patch inspector. Read commands stay available during work; starting another task or changing the repository/settings requires cancelling the active operation first. Describe a request to start work. `/repo` chooses a project; `/tasks`, `/status`, `/diff`, `/resume`, `/cancel`, and `/details` inspect and control work. `/set pull on` explicitly permits image downloads, and `/set install on` explicitly permits frozen dependency installation. `/set execution host` selects trusted host checks. Regular progress uses CTX stages and results; engine-specific evidence is available through `/details`. Authentication remains the connected provider's own sign-in flow (`ctx login` or `/login`). `ctx doctor` checks local prerequisites without running a model scan.

`/security` uses the security SDK underneath CTX. It reviews the last task's staged/unstaged changes in its private worktree, or the selected repository when there is no last task. Scans are explicit and separate from the coding task's completion/report status; this is not yet the Milestone 4 automatic security gate. They run in a subprocess with unrelated environment credentials removed and a requested read-only agent sandbox. Security output is saved privately outside the repository. The estimated scan budget is $1 (not a billing cap), with a five-minute worker timeout. SDK availability and input preflight do not establish account entitlement or completed coverage; unavailable, failed, and interrupted scans never become a security pass.

For development and rebuilding the downloadable bundle:

```sh
pnpm install
pnpm ctx                 # build and open the interface
pnpm release             # build a bundle; includes real PTY acceptance
pnpm test:tui            # native UI tests using the bundled runtime
pnpm release:check       # relocated and installed executable acceptance
```

The release builder downloads a pinned official Node.js archive, checks its SHA-256 against the official manifest, copies only production dependencies, verifies portable package links, and writes a release checksum. Credentials, task databases, and workspace artifacts are excluded. Only the Linux x64 release has been built and tested here; other platforms require their own validated builds.

CTX freezes task-specific verification before Codex starts. Simple requests such as `Create folder demo`, `hello can you make a folder` (uses `new-folder`), or `Create file note.txt with content "hello"` use deterministic filesystem checks in `auto` mode. These checks only inspect the private worktree; they do not execute project code or require Docker/build scripts. Codex still runs in its workspace-write/no-network SDK sandbox. Application changes run available build/test/typecheck checks, with a test command required. Explicitly supplied checks are always required, including for filesystem requests. Authentication/security-sensitive tasks additionally require a configured security check; unavailable checks never count as passing.

```sh
ctx run 'Create folder demo' --repo /path/to/project
ctx run 'Create file note.txt with content "hello"' --repo /path/to/project
ctx run 'Fix the feature' --repo /path/to/project --execution host
ctx run 'Fix the feature' --repo /path/to/project --execution auto --allow-host-fallback
ctx run 'Make the requested changes' --repo /path/to/project --acceptance criteria.json
pnpm test:engineering-live  # authenticated real Codex filesystem and TypeScript acceptance
```

`--acceptance` accepts a nonempty JSON array of `{ "kind": "directory"|"file"|"markdown", "path": "relative/path" }` or `{ "kind": "content", "path": "note.txt", "content": "expected", "match": "exact"|"contains" }`. Paths cannot escape the worktree or traverse symbolic links. Markdown checks validate local link targets and external URL syntax; external network reachability is unverified. A general prose request with no deterministic criteria remains an application task; provide criteria for non-code work.

`--execution docker` always fails safely when Docker is unavailable. `--execution host` explicitly permits project checks as the current user without container isolation. `--execution auto` never falls back to host implicitly. Disposable services still require Docker. Missing local dependencies can be recovered with frozen lockfile installation only after `--allow-dependency-install`; lifecycle scripts remain disabled. UI equivalents are `/set execution auto|docker|host`, `/set fallback on`, and `/set install on`.

Lifecycle evidence distinguishes environment failure, Codex not started, Codex failure, verification failure, cancellation, and completion. Both UI modes expose `codex.session.started`, `codex.turn.started`, `codex.tool.started/completed`, `codex.turn.completed`, and verification events. Detailed mode retains the underlying journal and outputs. Changes stay in the reported private worktree. `changes.diff` contains files; `changes.manifest.json` records filesystem criteria including empty folders, which Git patches cannot represent. Review the worktree and use `git apply --check` before applying file changes; create approved empty directories explicitly in the source repository.

For another stack, provide both verification commands:

```sh
pnpm harness run "Implement the requested feature" --repo /path/to/repo \
  --build 'make build' --test 'make test' --timeout 600 --max-repairs 1
```

Node repositories default to `npm run build` and `npm test` when those scripts exist. Commands are frozen before execution. Docker is the preferred application verification backend; Docker unavailability blocks the task before spending a coding turn. Missing commands produce `blocked`. Failed checks first pass through deterministic environment diagnostics and a separate persisted recovery budget (3 attempts by default, configurable with `--max-recoveries`, maximum 10). Only remaining application failures trigger at most `--max-repairs` repairs (0 by default, maximum 10); exhausted budgets and repeated identical failures stop the task. Each repair resumes the final coding step's SDK session when one was captured, preserves prerequisite steps, and reruns both checks. Failed checks' logs remain in their original locations; each environment recovery or coding repair writes new logs under `verification-N/`. Agent execution failures stop without automatic replay.

`--model` selects the SDK model. `--timeout` is a whole-task wall-clock budget, including downtime across restarts. Ctrl-C cancels the active agent/check. Cancellation is terminal; unexpected process death is handled by `resume`.

## Plans and scheduling

The deterministic default plan is one coding step carrying the user's request. `--plan path/to/plan.json` accepts a multi-step DAG; it does not make a separate planning model call:

```json
{
  "version": 1,
  "steps": [
    {
      "id": "feature",
      "title": "Implement feature",
      "instructions": "Implement the requested feature while preserving current behavior.",
      "dependencies": [],
      "acceptanceCriteria": ["Feature works and existing behavior remains covered."]
    },
    {
      "id": "coverage",
      "title": "Add regression coverage",
      "instructions": "Add tests for the feature and edge cases.",
      "dependencies": ["feature"],
      "acceptanceCriteria": ["Build and tests pass."]
    }
  ]
}
```

Runtime validation rejects malformed steps, duplicate IDs, missing dependencies, cycles, and forged statuses. Plans are immutable after submission and stored by version. Exactly one step runs at a time; a dependent step waits for its prerequisites' recorded execution results. After all coding steps pass, the frozen required checks run in the selected backend as completion gates. Structured filesystem criteria are independently machine-verified; prose plan criteria remain guidance to the agent.

## State, recovery and evidence

`<repo>/.harness/harness.sqlite` is authoritative. `--output /other/path` selects another state/evidence root. SQLite stores tasks, versioned plans, steps, attempts and idempotency keys, append-only events, leases, checkpoints, managed worktree/container/network resources with cleanup status, environment recovery budgets, and artifact paths/checksums. Schema version 2 migrates existing version 1 resource records without dropping task data. State changes and their event/checkpoint writes share a transaction. Intent is committed before preparing a workspace, launching a coding turn, running a verification command, or provisioning a recovery resource. Session IDs and completed turns are checkpointed as SDK events arrive; check results are saved individually.

```sh
pnpm harness status --repo /path/to/repo
pnpm harness status <task-id> --repo /path/to/repo
pnpm harness logs <task-id> --repo /path/to/repo
pnpm harness resume <task-id> --repo /path/to/repo
pnpm harness diff <task-id> --repo /path/to/repo
```

`status` and `logs` read the database and work during execution, before report exports exist. Resume uses the saved model, commands, plan, budgets, workspace, and environment configuration; configuration overrides are rejected. An active local worker cannot be displaced, even if its heartbeat is late. After a dead worker's lease expires (5 seconds by default), a new worker can claim the task. Remote-host leases are conservatively refused: this is a local-first runner, not distributed scheduling. PID reuse may require manual inspection rather than automatic lease takeover.

Recovery inspects the saved state, workspace, session/outcome, and completed check artifact hashes. Confirmed completed turns advance without another agent call; confirmed check results are reused. Terminal tasks regenerate evidence exports without rerunning coding or verification. **An agent turn, workspace preparation, recovery action, or command with an ambiguous interrupted outcome blocks for manual inspection.** The harness does not automatically repeat a potentially non-idempotent external action, infer success from a diff, or silently discard a partial workspace. Inspect the retained session, processes, and workspace before deciding whether to submit a new task. `resume` does not override a blocked, failed, completed, or cancelled task.

Per-task exports under `<output>/<task-id>/` include:

- `task.json`: latest task/checkpoint snapshot.
- `events.jsonl`: ordered SQLite journal export, including session IDs.
- `build.log`, `test.log`: initial check output; labeled if truncated to the final 1,000,000 characters.
- `verification-N/`: check logs for each environment recovery or coding repair round.
- `environment/recovery-N.log`: deterministic diagnostic/action evidence, referenced by the report and SQLite artifact checksums.
- `changes.diff`: binary-capable Git patch, including new files.
- `report.json`, `report.md`: outcome, summary, verification, security limitations, environment and usage.

Exports are atomically replaced and regenerated on resume; an interrupted export does not erase durable task state. Artifact metadata includes SHA-256 checksums. Keep the SQLite file and its `-wal`/`-shm` companions together when backing up an active runner. Do not edit the database manually. Milestone 1 file-only runs have no database checkpoints and cannot be resumed.

## Worktrees and Docker

The source, including dirty and untracked files, is snapshotted into a private Git repository. A detached Git worktree is created from that snapshot. The original repository and its Git metadata are never modified; ignored development files are retained, and originally tracked files retain their tracked status even if they match `.gitignore`. `.git`, `node_modules`, and `.harness` are excluded from the source copy; symlinks are rejected. The snapshot and worktree remain available for review and manual adoption of the diff.

The Codex worker uses the SDK workspace sandbox with network/web search disabled and no approval escalation. Independent build/test commands run in Docker with a read-only root filesystem, a writable task worktree, read-only private Git metadata, no Docker socket or host home-directory mounts, a non-root UID, dropped capabilities, no new privileges, a 512 MiB memory limit, one CPU, and a PID limit. A task-owned **internal** Docker network connects only its disposable services; no host service ports are published. The default image is `node:22-bookworm-slim`; `--image` selects a compatible prebuilt image for other stacks or browser prerequisites. Runtime images must already be cached unless `--allow-image-pull` explicitly permits pulling them.

Use `--execution host` only for trusted local commands. Host mode is explicit, reported, and disables service/dependency recovery; it cannot be selected by repository configuration. Existing Milestone 2 tasks without environment state retain their original host semantics on resume. Container isolation is never inferred from a worktree alone.

## Environment recovery

Declare disposable services in `.harness-environment.json` in the target repository:

```json
{
  "services": {
    "postgres": true,
    "mock": {
      "urlVariable": "PAYMENTS_API_URL",
      "keyVariable": "PAYMENTS_API_KEY",
      "routes": [
        { "method": "GET", "path": "/account", "status": 200, "body": { "balance": 10 } }
      ]
    }
  }
}
```

The repository file may only declare services. Execution mode, image, pull permission, installation permission, and budgets must come from CLI/API options. Alternatively, `--services services.json` accepts the inner services object. PostgreSQL may also be inferred from a `pg`/`postgres` dependency together with a PostgreSQL hint in `.env.example`. Service endpoints are always task-local; existing shared database endpoints are never probed or migrated by recovery.

Services start only after a matching verification failure. PostgreSQL connection/DNS failures start `postgres:16-bookworm` with tmpfs data on the internal network. Both `pg_isready` and `psql SELECT 1` must pass before the action succeeds, then **all required application checks rerun**, including any configured migration behavior. `DATABASE_URL` points at this disposable test database. This verifies local application behavior, not a production database integration.

An explicit mock contract handles missing API credentials or a missing mock endpoint. Its health check must pass; the configured URL variable points at the private mock, and an optional key variable receives a mock-only placeholder. Responses are static JSON, include `x-harness-mock: true`, and unknown routes return 404. Mock coverage is labeled in reports and live external API integration remains unverified. No contract means the task blocks rather than inventing credentials or mock responses.

Missing `.env` failures create a new file exclusively (never overwrite an existing file), using task-local service URLs and non-secret placeholders derived from **key names only** in `.env.example`. Example values are not copied. Application build/tests must then validate the configuration.

Bare package failures may use frozen `npm ci` or `corepack pnpm install` commands only with **`--allow-dependency-install`**, which authorizes network access for that isolated install container. Lifecycle scripts are disabled; unsupported/missing lockfiles block. Existing proxy settings and a configured public proxy CA are passed to this networked step with TLS verification enabled. Verification containers remain on the internal network. Missing local source files are treated as code failures, not dependency failures.

Recovery intent, consumed budget, resource names, health results, and evidence logs are persisted. A failed or repeated recovery blocks rather than looping or spending model repair turns. Port collisions and missing browsers are classified but have no generic verified automatic fix: use application-specific ports or an appropriate prebuilt image. Only task-labeled resources may be adopted or removed; unrelated Docker resources are refused. On terminal outcomes the manager removes its check/service containers and network, records cleanup errors, and retains the Git worktree. Resume retries pending cleanup without rerunning completed work. An interrupted recovery with an unknown outcome blocks for inspection rather than being replayed.

## Remaining limits

Automatic security gates, production verification, deployments, approvals, and automated worktree deletion remain deferred. Coding task reports still mark security unavailable; explicit CTX security scans have their own result and evidence. Known credential environment values and OpenAI key patterns are redacted from logs and prompts as best-effort hygiene; diffs still require review before sharing. Diffs over 1,000,000 characters fail evidence capture explicitly. Worktrees and frozen dependencies consume host disk space; the Docker memory limit does not provide a quota for the writable workspace. See [operations](docs/OPERATIONS.md) for prerequisites and acceptance testing.

After `pnpm build`, use `node dist/apps/cli/src/index.js` directly if desired. Exit codes: 0 completed, 1 failed/blocked/invalid input, 130 cancelled. `approve`, background `cancel`, `security`, and log following remain deferred. Unsupported commands/options fail explicitly.

## Verification

```sh
pnpm build
pnpm typecheck
pnpm test           # deterministic unit/integration suite; live test explicitly skipped
pnpm test:live      # real SDK/model, explicit host verification; consumes tokens
pnpm test:docker    # real Docker/PostgreSQL recovery; cached images required
```

The suite kills real worker processes with SIGKILL, then verifies safe restart after a confirmed turn, blocking for ambiguous agent/verification actions, preserved workspace changes, no duplicate side effects, lease exclusion, transaction rollback, valid DAG scheduling, and bounded repair. Those crash scenarios use deterministic agent adapters, not a live model. The separate live acceptance test requests a fixture feature through the actual Codex SDK and requires a real diff plus independently passing build/test commands; it prints its evidence directory.

The environment tests exercise worktree preservation, sandbox arguments, deterministic recovery, health failures, budgets, and cleanup using an explicitly simulated Docker driver. The mock-service template is also tested as a real local HTTP server. `test:docker` uses the real Docker driver and PostgreSQL wire protocol; missing Docker access fails the acceptance test and produces a blocked evidence report instead of being counted as a pass. `HARNESS_ALLOW_IMAGE_PULL=1 pnpm test:docker` explicitly permits required image pulls.
