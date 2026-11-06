# CTX current state

The authoritative product specification is [the master roadmap](CTX_Autonomous_Orchestration_Master_Roadmap.md).

The Phase 00 audit dated 2026-11-06 is in [docs/architecture/current-state.md](docs/architecture/current-state.md). See its implementation map before starting Phase 01.

Baseline decision: [ADR-000](docs/decisions/ADR-000-baseline.md). Commands, outcomes, environment failures, and the phase gate: [Phase 00 report](docs/verification/phase-00/REPORT.md).

Current capability: a persistent, independently verified single-task runner with CLI/OpenTUI, Codex SDK integration, isolated workspaces, and bounded repair. The roadmap's unattended V1 backlog supervisor remains to be built and demonstrated.

Phase 01 now adds validated V1 contracts, configuration resolution, typed command interfaces and acyclic package boundaries. See the [Phase 01 report](docs/verification/phase-01/REPORT.md), [ADR-001](docs/decisions/ADR-001-domain-contracts.md) and [package ownership](docs/architecture/package-ownership.md). Legacy task records keep their current format; Phase 02 will implement the new durable storage behavior.
