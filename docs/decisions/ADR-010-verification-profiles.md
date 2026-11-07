# ADR-010: Frozen owner-defined verification profiles

Date: 2026-11-07. Status: accepted for the tested Linux Phase 06 queue contract.

Verification requirements come from owner-registered immutable project profiles, never from agent output or changed package scripts. Migration 7 retains historical verification rows while adding the full status vocabulary, profile bindings, scoped waiver grants and verification process records. Historical migration SQL is unchanged; startup backup and active-worker guards remain in force.

The normalized profile records exact argv, backend, role, required flags, per-step timeout, test-summary format/minimum count and optional scanner opt-in. Explicit independent scope, test-integrity and secret checks are mandatory. Code profiles additionally require tests, syntax and dependency scanning. Host command execution requires an owner profile selecting host; unavailable backends are never silently downgraded. A tool whitelist is not a host sandbox or a guarantee that project code is safe.

Each attempt freezes its profile/hash before harness work. A missing binding remains missing even if a profile is later registered, so completion cannot acquire weaker gates mid-attempt. New requirements use a new profile ID. Local owner identity is supplied by trusted ingress; future remote ingress must authenticate before invoking these APIs.

Owner waivers apply only to explicitly waivable checks and bind task specification hash, immutable profile hash, check ID, the next attempt sequence, owner and expiry (maximum 24 hours). They are granted before an attempt; scope/test-integrity guards cannot be waived. Checks still run and retain observed failures/unavailability. An applied waiver is recorded as skipped_with_approval, never silently converted to passed. Required mock results do not prove live verification.

Independent execution now enforces these contracts through the queue result pipeline. Required command gates use exact argv, positive test-count evidence, per-step deadlines, retained process identities and post-command source/integrity/secret checks. A successful harness proof, matching archived workspace/commit, verified artifact hashes and scoped waiver consumption are required before the fenced completion transaction. Cancellation wins that transaction.

Each ordinary attempt publishes immutable structured runs/steps, report.json and REPORT.md; CLI task details verify their evidence before display. Historical report repair is explicitly nonpassing, requires confirmed quiescence, retains partial evidence and never reruns commands or invents requirements. The fixture-only and legacy single-task paths retain their separate contracts.

The existing Codex Security adapter stays opt-in with an explicit budget; disabled/unavailable service coverage is never passed. Independent offline baseline scanning checks syntax, credential patterns/known environment values and npm lock versions against an owner-approved advisory snapshot. Unsupported dependency ecosystems require an explicit scanner command or remain unavailable. No live feed, installation or complete security guarantee is implied. Injected mock execution remains mock_verified and cannot satisfy a required live gate. Host tools are operationally supervised, not sandboxed; Docker project commands require an explicitly supplied backend.

See [the Phase 06 report](../verification/phase-06/REPORT.md) and [execution/report contract](../architecture/verification-gates.md) for acceptance evidence and limitations. No SDK/adapter dependency version changed.
