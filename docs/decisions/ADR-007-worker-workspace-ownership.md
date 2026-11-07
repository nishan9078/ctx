# ADR-007: Durable workspace ownership and sampled runtime budgets

Date: 2026-11-06. Status: accepted; Phase 05 Linux gate verified on 2026-11-07.

Preserve the private snapshot strategy: dirty/untracked source content becomes a private baseline, while the registered source Git metadata and files remain untouched. Task branches belong to this private repository; source branches are not modified or automatically merged.

Migration 6 adds project device/inode identities, workspace ownership records and exclusive attempt-fenced workspace access. Ownership is committed before filesystem creation. Filesystem nonce/inode markers must agree with the registry before a workspace can be reused or removed. Task settlement releases exclusive access only after quiescence; recovery retains ownership for live or unknown worker groups. Historical migration SQL remains unchanged. Existing projects require an explicit owner registration call to bind their current inode identity after upgrade; do not silently trust a replaced directory.

Cleanup must verify terminal task state, lack of active writers/verifiers, retention, ownership and an intact content archive matching the current worktree. Unarchived dirty work, unknown directories, path/marker substitutions and uncertain processes are retained for inspection. No arbitrary `git clean` or deletion of unrecorded paths is allowed.

Phase 05 extends cancellation-aware workspace preparation and the existing supervised SDK host with configured sampled RAM/CPU/disk health. Existing SQLite queue limits remain the authoritative concurrency gate. Sampled budgets are operational limits, not an adversarial VM or an entitlement to modify global machine configuration. See the phase report for actual verified capability and remaining work.

## Verified implementation

`OwnedWorkspaces` creates private task branches/base SHAs, records a root nonce and root/snapshot/worktree inode proof, preserves both trees plus Git references in content-bound archive receipts and requires terminal state/quiescence/retention before deletion. Explicit resume acquires the unique workspace access record. Unknown/legacy directories and unarchived or changed content remain retained.

The SDK supervisor applies sampled RSS/CPU/disk health and wall budgets with bounded stdout/stderr. Local Git preparation uses an owned IPC host; scoped sessions avoid per-command Node forks and exit at operation end. Both paths handle parent loss and inherited descendants. Git overrides/hooks/filters cannot redirect trusted evidence capture. This is Linux process-group supervision with sampled operational budgets, not a cgroup/VM or malicious same-user boundary.

Final evidence: 284 passing development tests, six optional live skips, strict typecheck/boundaries and 41 bundled-runtime acceptance checks. No new live generation or dependency upgrade. See the [Phase 05 report](../verification/phase-05/REPORT.md) and [runtime API](../architecture/worker-runtime.md).
