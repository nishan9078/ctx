# ADR-011: Bounded checkpoint-based queue repair

Status: accepted for the tested Linux recovery contract. No schema or adapter version change.

Queue repair is an explicit `recovery` option on `createCodexQueueScheduler`. Default execution retains its existing single-attempt behavior. The option is normalized to bounded attempt/class/repeat/time/token settings, with exponential backoff and jitter. Optional cost ceilings fail closed before invocation because the pinned provider does not report authoritative cost. Reported tokens are checked on SDK usage events; these are observation bounds, not a provider-side generation cap.

Failed verification creates a versioned managed checkpoint before final task disposition. It binds the specification, immutable profile, recovery policy, report evidence, workspace tree, base commit, private branch and session. Checkpoint reads verify referenced evidence and current workspace bytes; a mismatch requires owner reconciliation. Recoverable test/build failures resume the same private worktree with a concise failure packet and rerun the complete frozen verification profile. Existing tests, security and scope checks cannot be weakened by repair.

Recovery scheduling is transactional and revision/audit preserving. It never advances the task retry epoch or resets attempt counts. Pending, rejected and expired approvals block automated scheduling; rejected approvals also block ordinary manual retry. Checkpoints and original reports remain immutable. Unknown effects, auth, security, environment, install, missing-file and crash failures have distinct diagnoses and stop for reconciliation rather than speculative model execution. No LLM diagnostic call is made for unknown errors.

The existing EnvironmentManager remains the approved mechanism for disposable local infrastructure: declared services, explicit install/image permissions, ownership records, persisted recovery intent, bounded attempts, and mock-only/live-unverified labeling. It is not automatically attached to ordinary queue worktrees. Queue environment failures remain blocked until that approved infrastructure is prepared; no arbitrary host service startup is added.

Partial SDK output and workspaces remain retained after crashes. Automatic repair requires a completed failed-verification checkpoint; a crash with no trustworthy checkpoint remains blocked. Phase 05's confirmed-dead ownership reconciliation and Phase 06's nonpassing incident reports remain authoritative. Interrupted external effects are never replayed automatically.
