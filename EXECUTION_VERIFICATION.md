# CTX execution verification

The original failure occurred in `EnvironmentManager.prepare()`, after private Git worktree preparation but before `agent.execute()`. The real runner does not inherit Docker GID 973, although `/etc/group` already lists the account. A subprocess cannot obtain that missing authority by changing spawn options. A separate verifier defect always required build and test scripts, including for simple filesystem tasks.

The execution path is now: UI/CLI request → persisted plan and immutable verification policy → private Git worktree → explicit backend selection → existing Codex SDK adapter and bundled CLI → persisted SDK and normalized lifecycle events → independent verification → bounded recovery/repair → retained report/diff/filesystem manifest.

## Implemented policy

- `docker` requires functioning Docker; no automatic isolation downgrade.
- `host` explicitly permits local verification commands as the current user. Codex tools retain the SDK workspace-write/no-network sandbox.
- `auto` uses Docker for application checks unless host fallback is explicitly permitted. Deterministic filesystem acceptance needs no project-command executor or unrelated application services.
- A task blocked before Codex starts can be retried with explicit `/retry host` approval. Previously started/ambiguous work is refused by this shortcut.
- Folder/file/content/Markdown criteria are independently checked. Application build/test/typecheck checks are selected before execution; explicit checks and required security checks cannot disappear.
- Frozen dependency installation requires permission and disables lifecycle scripts. The recovery budget and rerun evidence remain durable.
- Release installations are rejected as task targets. Launch cwd, selected target and executable path remain separate.
- Filesystem changes remain in the reported worktree. Empty folders are recorded in `changes.manifest.json`, because Git patches cannot represent them. File changes should be reviewed and checked with `git apply --check` before application.

## Observed verification

| Case | Evidence and execution |
| --- | --- |
| Original folder request through installed OpenTUI | Real Codex, independent directory verification, `completed`; `.harness/execution-smoke-installed/live-report.json` |
| Create directory and exact-content file | Real Codex; `.harness/engineering-live/ec927413-1cd8-4434-aba0-386080b34698/report.json` |
| Repair TypeScript function | Real Codex, TypeScript compiler and independent test; `.harness/engineering-live/23fe94fd-d5f2-4c4e-bcdc-c731f7002d15/report.json` |
| Missing local dependency | Fixture agent, real frozen npm installation from a local package, then passing verification; `tests/integration/engineering.test.ts` |
| Docker unavailable / no false success | Real daemon access denied, `blocked`, zero Codex turns; `.harness/execution-docker-probe/59ef283a-1af0-4cbc-a2d6-0759495a7087/report.json` |
| Explicit host approval and missing security check | Deterministic integration tests; no implicit fallback and no skipped required check |
| Release | Archive checksum, relocation, PTY commands/modes/resizing/cancellation, terminal restoration, installation and upgrade with backups passed |

`pnpm test`: 98 passed, 4 opt-in live tests skipped. The new authenticated filesystem and TypeScript cases were run separately and passed. `pnpm test:tui`: 4 passed. The regression suite also passed on the bundled Node 26 runtime. `pnpm release` and `pnpm release:check` passed. The installed executable was then tested with:

```sh
CTX_PTY_LIVE=1 CTX_SMOKE_EVIDENCE=.harness/execution-smoke-installed \
  python3 scripts/verify-terminal.py /home/nishan/.local/bin/ctx tests/fixtures/feature quit
```

The TypeScript fixture initially exposed this host Node 22 build's missing native TypeScript stripping support. The corrected fixture uses the installed TypeScript compiler; real compilation and tests passed. This is not evidence that arbitrary runtimes support native TypeScript.

Docker/PostgreSQL container acceptance is still externally blocked by stale runner groups. Log out/back in and fully restart the terminal/runner from the refreshed session to use Docker. No socket permissions or privileged group membership were changed. No general live security-scan coverage or external URL reachability is claimed.
