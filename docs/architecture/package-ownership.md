# Package ownership after Phase 01

Logical ownership is explicit without creating empty workspace packages. All packages still build through the root strict TypeScript compiler. Internal source imports remain relative until formal exports are useful.

| Logical area | Current source owner | Boundary |
| --- | --- | --- |
| Domain/contracts | `packages/shared/src/domain.ts`, `validation.ts`, `errors.ts`, `transitions.ts`, `config.ts`, `verification.ts` | No imports from any other application package. No SQLite, SDK, environment-manager or UI implementation types. |
| Core | `packages/core` | Coordinates application use cases, typed command contracts, trusted configuration resolution and existing task runner. |
| Scheduler | `packages/core/src/scheduler.ts`, future P03 controller | Current file schedules legacy plan steps only. P03 owns task eligibility, ordering, leases, concurrency and pause/cancel semantics. |
| Persistence | `packages/persistence` | Owns schema/migrations, transactions and stored record representation. Legacy record can reference neutral and runtime result types; it must not import core. P02 adds V1 storage/command handlers. |
| Adapters | `packages/agents`, `packages/security` | Own vendor SDK translation and capability probes. New `WorkerEvent` is the P04 normalization target; legacy SDK event behavior is preserved now. |
| Runtime | `packages/environment` | Owns Git isolation, subprocess ownership, disposable services and resource/permission checks. It does not own queue decisions. |
| Verification | `packages/verification` | Owns independent check planning/execution and gates; common result/plan types live in shared. |
| Integrations | Future P09/P12 modules | Own Discord/MCP ingress, authorization and notification transport behind core command contracts. No placeholder integration package is created in P01. |
| CLI/OpenTUI | `apps/cli` | Owns parsing/presentation and currently the legacy runner session; migrates to the daemon command interface in P08/P14. Never defines new durable task state. |

`core/src/types.ts` and `core/src/state-machine.ts` are compatibility facades for existing callers. They do not convert legacy storage records into V1 domain objects.

Run `pnpm check:boundaries` to parse static imports, exports, import types and dynamic literal imports using the installed TypeScript parser. The gate rejects package cycles, including type-only cycles, and any shared-to-implementation dependency. It checks source topology, not third-party dependency vulnerabilities or runtime authorization. The Phase 01 evidence contains the resulting graph.
