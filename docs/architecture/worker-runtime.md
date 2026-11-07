# Worker runtime budgets and recovery

The durable queue now uses `OwnedWorkspaces` for preparation, explicit resume and archival. Creating or resuming a workspace acquires its unique attempt-fenced access record. Attempt settlement/reconciliation releases access only after the relevant workers are quiescent. Existing pre-Phase-05 directories are never silently adopted.

## Resource policy

`workerRuntimeBudget` validates local owner settings. Defaults are:

| Budget | Default |
| --- | ---: |
| Maximum SDK worker group RSS | 2 GiB |
| Observed group CPU time | 3,600 seconds |
| Runtime wall time | 90 minutes, also bounded by the task's wall budget |
| Workspace disk use | 2 GiB, including private snapshot/Git metadata |
| Minimum free disk | 10 GiB |
| Minimum available system memory | 128 MiB |
| Sample interval | 1 second |
| SDK host stdout/stderr tails | 16 KiB each, explicit truncation flags |
| Git command output | 1,000,000 characters, explicit truncation flag |
| Git command timeout | 120 seconds |

Preflight blocks before model launch if disk or available memory is below policy. Preparation checks copy volume and health between stages. The supervisor samples Linux `/proc` RSS/CPU and filesystem usage while running and once more after exit, so a fast disk writer cannot evade the final check. Budget or health-sink failures terminate the group before returning. Health and effective budget records are fenced attempt diagnostics.

RAM/CPU are sampled operational limits, not kernel-enforced cgroup quotas or an adversarial sandbox. RSS sums can count shared pages more than once; observed CPU excludes children that start and exit entirely between samples. The SDK process group is the accounting/termination boundary. A deliberately escaping process requires stronger OS containment; no such guarantee is claimed here. No global machine settings are changed.

The existing SQLite queue configuration remains the hard concurrency gate (one worker by default, maximum two; per-project limits also apply). An attempt does not retain an idle model session after execution. Ordinary task completion still requires the independent Phase 06 verification pipeline.

## Owner configuration and local APIs

Runtime configuration adds `maxWorkerRssMb`, `maxWorkerCpuSeconds`, `maxWorkspaceMb`, and `worktreeRetentionDays`; existing schema-version-1 files receive defaults. Permissions do not come from environment variables.

```ts
const budget = runtimeBudgetFromConfig(config.runtime);
const scheduler = createCodexQueueScheduler(repository, { runtime: budget });
const workspaces = new OwnedWorkspaces(repository, {
  retentionDays: config.runtime.worktreeRetentionDays,
});
```

The scheduler's configured wall budget and the task wall deadline both apply. The existing supervisor `graceMs` option can be provided through an injected supervised executor when selecting an owner shutdown policy. Its default cooperative/TERM escalation remains one second plus forced cleanup.

After a crash, `workspaces.reconcileOrphans(actor)` reconciles only confirmed-dead queue owners, then reports recorded resources and unowned paths. `{ cleanup: true }` requests cleanup only through the same archive/terminal/retention/ownership guards as explicit cleanup. Unarchived, blocked, active, unknown or unsafe resources remain retained. A trusted owner may explicitly archive stopped work, review/cancel it, then request cleanup. No scanner invents task completion or resets owner files.

## Preparation command ownership

Local Git commands use an owned IPC command host as well. A scoped host serializes the Git operations for one preparation/archive/cleanup operation and exits at scope end. Parent disconnect kills its inherited group; tests cover resistant descendants and inherited output descriptors. Commands retain actual UID/GID/supplementary groups and never request new privilege. Direct command output, timeout and cancellation remain bounded. Session scopes avoid a Node process fork for each individual Git command.

Private Git operations clear inherited `GIT_*` overrides and disable global/system configuration, hooks, fsmonitor and external diff/textconv helpers. Local filter/include/worktree overrides are rejected before staging evidence. Source Git operations are read-only and do not take optional index locks. Common merge/rebase/cherry-pick/lock states and unsafe source symlinks refuse preparation.

## Migration and retained evidence

Migration 6 preserves prior schemas and creates workspace/access and project-identity records. Existing projects need an explicit owner registration call to bind the current device/inode; this is audited as `project.identity_bound`. A changed registered inode refuses execution rather than being silently rebound. Existing blocked tasks require explicit owner retry after revalidation.

Cleanup receipts bind exact worktree and private snapshot file trees, their hashes, Git references/HEAD state, a diff against the recorded base and a Git bundle. Changes after archival, including snapshot edits or new Git references, refuse cleanup until explicitly archived again. Bundles and exact-byte tree packages are binary, private artifacts without a redaction/scanner claim. Each tree archive is bounded to 10 MiB of source bytes and 10,000 entries; bundles retain the 16 MiB artifact cap. Oversized/unavailable archives retain the workspace instead of enabling deletion.

See [owned workspace lifecycle](owned-workspaces.md) and the [Phase 05 report](../verification/phase-05/REPORT.md) for tests and the actual gate status. CLI/OpenTUI still use the preserved single-task runner; the V1 queue is a local API pending daemon/client phases.
