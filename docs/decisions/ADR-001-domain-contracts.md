# ADR-001: Versioned domain contracts and compatibility boundaries

Date: 2026-11-06. Status: accepted for Phase 01.

## Context

The roadmap needs a shared vocabulary before queue/schema/daemon work. Existing database schema v2 stores a different task/step vocabulary and runner-specific environment fields. Phase 01 must not silently reinterpret those records.

## Decisions

### V1 domain and lifecycle

`packages/shared/src/domain.ts` owns `TaskSpec`, `TaskState`, `Attempt`, `WorkerEvent`, `VerificationResult`, `CapacityState`, `ApprovalRequest`, `Notification` and `PortableCheckpoint`. TypeScript fields use camelCase; roadmap YAML examples use illustrative snake_case and must be mapped by a future ingress importer, never silently accepted as a second schema.

Task input and portable checkpoint documents use `schemaVersion: 1`. Runtime validators reject unknown fields/versions, unsafe paths, malformed budgets, empty acceptance, self-dependency and invalid hashes. Multi-task DAG validation and registration checks at submission belong to P02/P03. Serializers validate both input and redacted output, redact known environment credentials and URL userinfo from string values, and cap JSON at 1 MB. They are not a comprehensive secret scanner: arbitrary unknown secrets must never be supplied as task/checkpoint content. Parsers return fresh validated objects; no worker/DB side effects occur during validation.

Named waiting states represent capacity, dependencies and approvals. `paused` is explicit and resumes through `queued` so eligibility is re-evaluated. Completed/failed/cancelled are terminal. Blocked is recoverable only through an explicit owner retry/revision. The pure transition table rejects same-state transitions; repositories can treat idempotent commands separately. Completion is reachable only from verifying. Transactional eligibility/evidence/lease/approval guards are P02/P03 responsibilities, not properties proven by this structural table. Pause currently models queued/waiting work; active-worker quiescence/pause policy must be implemented with process ownership in P03/P05.

### Legacy compatibility

The current runner keeps its exact task JSON, SQLite schema v2 and transition semantics, including its terminal `blocked` behavior and same-state journal updates. Legacy storage types now live in `persistence/src/task-record.ts`; `core/src/types.ts` remains a compatibility export. Pure legacy transition validation lives in shared, so persistence no longer imports core. `shared/src/verification.ts` owns neutral check-plan types, with compatibility exports from the existing planner. All source package cycles, including type-only cycles, are removed.

V1 contracts are the implementation target for P02/P03. They do not create a second runtime scheduler. P02 must explicitly choose migration/legacy import behavior and reject unknown stored versions; Phase 01 does not modify existing task rows or claim that legacy JSON casts are now validated by the new schema.

### Command boundary

`core/src/commands.ts` defines a typed bus for submit, cancel, pause, resume, approve/reject, retry and query. Inputs carry expected revisions where state changes, deduplication keys at submission, and exact action hashes for approval. Context identifies the trusted ingress actor; user text cannot supply authority. Results carry structured public errors. P02/P03 will supply durable handlers; P08 supplies authenticated transport. No placeholder handler pretends persistence or authorization exists.

### Configuration and secrets

`core/src/config.ts` resolves schema-v1 owner configuration: conservative defaults, owner runtime settings, then three supported runtime environment overrides (`CTX_MAX_WORKERS`, `CTX_MAX_WORKERS_PER_PROJECT`, `CTX_MAX_ATTEMPT_WALL_MINUTES`). Bounds and cross-field constraints are revalidated after overrides. Environment variables cannot expand repository allowlists, enable network access or change approval requirements. Paid capacity probes default off.

Project IDs must be registered and repositories must match an exact canonical allowlisted directory. A parent allowlist does not authorize child repositories. Commands come only from trusted project config, never task text. Paths are resolved without changing the global process environment. Filesystem identity must still be checked at use time by future runtime code.

Credentials remain in the environment/credential store. Config fields for credentials are rejected. Operational command strings can contain incidental secrets; use `projectConfigDiagnostics` for UI/log snapshots. Structured redaction handles credential-like keys, known environment values, common API-key text and URL userinfo without mutating operational data. Unknown arbitrary embedded secrets require the later scanning boundary.

### Retained architecture decisions

- **SQLite WAL:** retain the local single-host store; use migrations and transactional events in P02. No database backend replacement.
- **Per-task Git worktrees:** retain private snapshot worktrees that protect human source changes; formal registered-project branches/integration remain P05/P13 work.
- **SDK-first Codex:** retain installed SDK 0.166.0 and existing restricted adapter options; normalize events against the new neutral union in P04, not in this contract phase.
- **Non-LLM Sentinel:** daemon ownership and authenticated IPC arrive in P08; current CLI/TUI continue to call the tested runner until then. Idle capacity probes remain off by default.

See [package ownership](../architecture/package-ownership.md) and [baseline ADR](ADR-000-baseline.md).
