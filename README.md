# Autonomous Codex Engineering Harness

Milestone 1 implements one request → one isolated repository copy → one Codex turn → build and tests → evidence report. The orchestrator decides success from command results, rather than the agent's summary.

Requires Node.js 22+, pnpm 12, Git, and configured Codex authentication. The installed SDK is pinned to `@openai/codex-sdk@0.166.0`; its bundled CLI uses your existing Codex login or `CODEX_API_KEY`. See the [official SDK documentation](https://developers.openai.com/codex/sdk/).

```sh
pnpm install
pnpm build
pnpm test
pnpm harness run "Add a farewell function and tests" --repo tests/fixtures/feature
```

For another stack, provide both verification commands:

```sh
pnpm harness run "Implement the requested feature" --repo /path/to/repo \
  --build 'make build' --test 'make test' --timeout 600
```

Node repositories default to `npm run build` and `npm test` when those scripts exist. Commands are selected before the agent runs. Missing checks produce `blocked`; failed checks or agent failures produce `failed`. A task has one agent turn and no repair retries. `--model` selects an SDK model; omit it to use the configured default. Timeouts apply to the whole run and verification subprocesses. Ctrl-C cancels the active agent/check.

The source repository, including existing uncommitted files, is copied to a new temporary directory and committed as a local baseline. `.git`, `node_modules`, and `.harness` are excluded; symlinks are rejected. Dependencies are not installed automatically. Use dependency-free fixtures or an explicit trusted build command that installs what it needs. The original repository is never edited. The working copy is retained for review and manual adoption of its diff.

Evidence is stored under `<repo>/.harness/<task-id>/` by default; use `--output /other/path` to change the root:

- `task.json`: initial intent and configuration, written before execution.
- `events.jsonl`: sequenced lifecycle and SDK events, including session IDs.
- `build.log`, `test.log`: command output (last 1,000,000 characters, labeled if truncated), status/duration in the report.
- `changes.diff`: binary-capable Git patch, including new files.
- `report.json`, `report.md`: outcome, summary, verification, security limitations, environment and usage.

```sh
pnpm harness status <task-id> --repo /path/to/repo
pnpm harness logs <task-id> --repo /path/to/repo
pnpm harness diff <task-id> --repo /path/to/repo
```

After `pnpm build`, the entry point also runs with `node dist/apps/cli/src/index.js`. Exit codes: 0 completed, 1 failed/blocked/invalid input, 130 cancelled. `resume`, `approve`, `cancel`, `security`, and log following are deferred; the CLI rejects unsupported commands/options explicitly. Files are evidence records, not crash-safe resumable state.

The agent uses SDK `workspace-write`, disables network and web search, and cannot obtain approval escalation. A repository copy is change isolation, not a security boundary. **Verification commands run on the host: use trusted repositories and commands only.** Container isolation, policy approvals, scanners, durable recovery and cleanup management belong to later milestones. Known credential environment values and OpenAI key patterns are redacted from event/check logs and prompts; this is best-effort hygiene, and diff artifacts still require review before sharing. Diffs over 1,000,000 characters fail evidence capture explicitly rather than saving a truncated patch. Security is always reported as unavailable in this milestone; no live external service integration is inferred from fixture tests. Retained temporary workspaces can be deleted after review.

Tests distinguish deterministic SDK fakes from a real model run:

```sh
pnpm test           # unit/integration tests; live test explicitly skipped
pnpm test:live      # real SDK/model; requires authentication and network; consumes tokens
```

The live acceptance test requests a `farewell` feature in the fixture and requires an actual Git diff and passing independent build/test commands. It prints the persisted evidence directory. No SQLite, DAG planner, Docker provisioning, security scanners, or bounded repair loop is claimed by this milestone.
