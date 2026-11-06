# CTX current state

The authoritative product specification is [the master roadmap](CTX_Autonomous_Orchestration_Master_Roadmap.md).

The Phase 00 audit dated 2026-11-06 is in [docs/architecture/current-state.md](docs/architecture/current-state.md). See its implementation map before starting Phase 01.

Baseline decision: [ADR-000](docs/decisions/ADR-000-baseline.md). Commands, outcomes, environment failures, and the phase gate: [Phase 00 report](docs/verification/phase-00/REPORT.md).

Current capability: a persistent, independently verified single-task runner with CLI/OpenTUI, Codex SDK integration, isolated workspaces, and bounded repair. The roadmap's unattended V1 backlog supervisor remains to be built and demonstrated.

Phase 01 now adds validated V1 contracts, configuration resolution, typed command interfaces and acyclic package boundaries. See the [Phase 01 report](docs/verification/phase-01/REPORT.md), [ADR-001](docs/decisions/ADR-001-domain-contracts.md) and [package ownership](docs/architecture/package-ownership.md). Legacy task records keep their current format; Phase 02 will implement the new durable storage behavior.

Phase 02's V1 persistence gate passes: versioned migrations, transactional task submission, dependency/revision/audit rules, atomic hash-bound artifacts and database-plus-evidence backup/restore are verified. Fifteen acknowledged tasks survive SIGKILL/reopen, and a complete bundle restores after source removal. See the [Phase 02 report](docs/verification/phase-02/REPORT.md), [backup/restore runbook](docs/BACKUP_RESTORE.md) and [artifact/backup decision](docs/decisions/ADR-004-artifacts-backup.md). Restored legacy records/evidence require explicit worktree/process reconciliation; V1 managed artifacts relocate directly.

Phase 03's queue/fixture gate passes on development and bundled runtimes: schema v4, deterministic DAG/priority/concurrency, persisted pause/cancel/retry/deadlines, process-aware leases/fencing, confirmed-dead recovery and independently verified fixture-only completion. See the [Phase 03 report](docs/verification/phase-03/REPORT.md), [queue lifecycle API](docs/architecture/queue-lifecycle.md) and [ADR-005](docs/decisions/ADR-005-durable-scheduler.md). Fixture tasks preserve one visible receipt effect across forced restarts; real external actions are not claimed exactly-once. Next: P04's real Codex adapter/event integration, followed by process/worktree supervision and real verification. CLI/OpenTUI still use the preserved legacy path pending planned integration. No unattended V1/release readiness is claimed.
