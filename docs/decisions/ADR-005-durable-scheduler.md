# ADR-005: Fenced queue lifecycle and explicitly isolated fixture execution

Date: 2026-11-06. Status: accepted for Phase 03.

## Storage and migration

Migration 4 adds durable retry epochs, control intents and lease owner PID/host/process identity. It rebuilds the attempts table to add the explicit `fixture` worker kind, retaining historical rows and every foreign-key relationship. Historical migrations 2/3 remain unchanged. Upgrade rejects active V1/legacy leases or attempts and verifies historical checksums before migration.

The rebuild temporarily defers foreign-key checks within the writer transaction. SQLite retains deferred DROP counters after the replacement parent table is populated. The runner performs a full `foreign_key_check` first, then clears those obsolete deferred counters before commit; `foreign_keys` remains ON throughout. Tests preserve attempts, artifacts, checkpoints and sessions and prove invalid references still fail after commit. Migration failure rolls back, with the pre-migration snapshot retained. Backups continue to recognize v2/v3/v4; opening an older restored V1 store upgrades through the same validated path.

## Eligibility and claims

`TaskRepository.queue` owns persisted queue operations through an internal persistence capability. SQL is not exposed to core/UI. `DurableScheduler` owns runtime promises, abort signals and heartbeat timers. The old single-task runner stays available for compatibility; it is not automatically fed tasks from the new queue.

Eligible tasks are delegated, registered at their unchanged canonical directory, past any retry deadline, within their bounded attempt epoch, free of pending approvals, and have every hard prerequisite completed. Failed/cancelled/blocked prerequisites block descendants with an explicit reason. Paused/incomplete dependencies keep descendants waiting. Eligibility is deterministic: priority, recorded creation time, then task ID. One-slot fixture tests demonstrate a deterministic 15-task DAG order; parallel completion timing is allowed to vary.

Claim takes the SQLite writer lock, rechecks eligibility/registration, enforces persisted global/per-project limits (1–2), transitions the task, creates its attempt and lease and appends audit history atomically. The monotonically increasing attempt sequence is the fencing token and never resets on an owner retry. Expired-but-live owners continue consuming a slot; expiry alone is never authority to steal it.

## Ownership and recovery

Leases bind a controller instance, PID, host, start fingerprint and expiry. Linux fingerprints include PID namespace, host boot ID and process start ticks. Different namespaces/unknown hosts are quarantined; they are not comparable PID spaces. A previous boot or missing process in the known namespace proves the previous owner exited. Where start fingerprints are unavailable, a live/reused PID is handled conservatively rather than guessed dead.

Heartbeat/start/verification/finalization writes require the current unexpired lease and fence. Attempt-linked artifact registration is also fenced. Old workers cannot overwrite or clean up a new attempt. An expired lease can be released by its matching live owner only through the explicit stopped/quiescence path after its worker promise settles.

On restart, reconcile expired leases against actual owner identity. Dead fixture owners can be rescheduled because their output receipt is explicitly idempotent and the worker dies with the owner process. Real harness effects are not inferred safe from controller death; those tasks block for later harness/process reconciliation. Process-group supervision/reattachment is P04/P05 work.

## Control and retry policy

Global pause is persisted and uses drain policy: no new claims or unstarted worker invocations, while already-running attempts may finish. Task pause immediately pauses quiescent work; active work drains its current attempt. Independently verified success may complete; a retryable outcome pauses before another attempt. Resume re-evaluates dependencies/deadlines. Pause cannot reverse a cancellation.

Cancellation of active work is a durable intent, not an immediate terminal status. The controller observes it on heartbeat, forwards an abort signal, and holds the slot until the worker promise actually settles. A worker ignoring abort remains managed and fenced; it is never described as stopped merely because an observation/shutdown timer expired. Observation timeouts leave live work running under its owner. Real process termination guarantees arrive with the P05 runtime.

Failures/capacity waits release quiescent workers and persist `next_run_at`. Automatic claims are capped by `maxAttempts`; claims reserve attempt budget even if a later launch fails. Attempt wall-time is bounded by the task's configured minutes; aggregate token/cost/repair budgets are later recovery work. An explicit owner retry creates an audited new task revision and retry-budget epoch, preserving old attempts and increasing fences. Ordinary terminal-state transitions remain forbidden; completed tasks cannot be retried in place.

## Fixture boundary and evidence

The fake worker is `fixture`, never mislabeled Codex/OpenCode. It runs only projects explicitly registered with policy `fixture-only`, profile `fixture-v1`, and the exact shared `fixtureAcceptance` criterion. It writes deterministic receipts under CTX's data directory and never edits the source project or calls a provider.

A separate verifier reads the actual receipt, checks task ID/objective/spec hash and creates immutable attempt-bound output/report artifacts. Queue completion rechecks lease, project/profile, artifact ownership/hashes, report/result binding and cancellation intent; it persists required verification steps and completion/outbox records transactionally. The report labels the result fixture-only. Ordinary engineering tasks cannot pass through this completion method. Real harness completion requires the P06 evidence pipeline.

Restart after an output receipt preserves its original execution ID and checks it before reuse. This proves one visible fixture effect across interrupted attempts, not magical exactly-once execution of arbitrary external actions. Approval fixtures persist a pending action hash and stop; resume/retry cannot grant approval. Real decision authorization/templates are P09 work.
