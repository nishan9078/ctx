# ADR-010: Frozen owner-defined verification profiles

Date: 2026-11-07. Status: Phase 06 implementation in progress.

Verification requirements come from owner-registered immutable project profiles, never from agent output or changed package scripts. Migration 7 retains historical verification rows while adding the full status vocabulary, profile bindings, scoped waiver grants and verification process records. Historical migration SQL is unchanged; startup backup and active-worker guards remain in force.

The normalized profile records exact argv, backend, role, required flags, per-step timeout, test-summary format/minimum count and optional scanner opt-in. Explicit independent scope, test-integrity and secret checks are mandatory. Code profiles additionally require tests, syntax and dependency scanning. Host command execution requires an owner profile selecting host; unavailable backends are never silently downgraded. A tool whitelist is not a host sandbox or a guarantee that project code is safe.

Each attempt freezes its profile/hash before harness work. A missing binding remains missing even if a profile is later registered, so completion cannot acquire weaker gates mid-attempt. New requirements use a new profile ID. Local owner identity is supplied by trusted ingress; future remote ingress must authenticate before invoking these APIs.

Owner waivers apply only to explicitly waivable checks and bind task specification hash, immutable profile hash, check ID, the next attempt sequence, owner and expiry (maximum 24 hours). They are granted before an attempt; scope/test-integrity guards cannot be waived. Checks still run and retain observed failures/unavailability. An applied waiver is recorded as skipped_with_approval, never silently converted to passed. Required mock results do not prove live verification.

Phase 06 will enforce these contracts at independent execution and transactional completion, publish report.json/REPORT.md and expose evidence through task details. See the phase report for actual completed coverage; the foundation alone does not permit real-task completion.
