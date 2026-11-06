# ADR-007: Durable workspace ownership and sampled runtime budgets

Date: 2026-11-06. Status: implementation in progress for Phase 05.

Preserve the private snapshot strategy: dirty/untracked source content becomes a private baseline, while the registered source Git metadata and files remain untouched. Task branches belong to this private repository; source branches are not modified or automatically merged.

Migration 6 adds project device/inode identities, workspace ownership records and exclusive attempt-fenced workspace access. Ownership is committed before filesystem creation. Filesystem nonce/inode markers must agree with the registry before a workspace can be reused or removed. Task settlement releases exclusive access only after quiescence; recovery retains ownership for live or unknown worker groups. Historical migration SQL remains unchanged. Existing projects require an explicit owner registration call to bind their current inode identity after upgrade; do not silently trust a replaced directory.

Cleanup must verify terminal task state, lack of active writers/verifiers, retention, ownership and an intact content archive matching the current worktree. Unarchived dirty work, unknown directories, path/marker substitutions and uncertain processes are retained for inspection. No arbitrary `git clean` or deletion of unrecorded paths is allowed.

Phase 05 will extend cancellation-aware workspace preparation and the existing supervised SDK host with configured sampled RAM/CPU/disk health. Existing SQLite queue limits remain the authoritative concurrency gate. Sampled budgets are operational limits, not an adversarial VM or an entitlement to modify global machine configuration. See the phase report for actual verified capability and remaining work.
