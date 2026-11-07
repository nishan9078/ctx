import { writeRecoveryCheckpoint } from './recovery-checkpoint.js';
import { recoveryPolicy, type RecoveryPolicy } from '../../shared/src/recovery-policy.js';
import type { CommandActor } from '../../shared/src/domain.js';
import type { FixtureVerification, LeaseClaim, WorkerOutcome } from '../../shared/src/scheduling.js';
import type { TaskRepository } from '../../persistence/src/task-repository.js';
import { CtxError } from '../../shared/src/errors.js';
import { verifyEngineeringAttempt, type VerificationOptions } from './engineering-verification.js';
import { verifyFixture } from './fixture-worker.js';
export type AttemptFinalizer = (claim: LeaseClaim, outcome: Extract<WorkerOutcome, { kind: 'success' }>, actor: CommandActor, signal: AbortSignal) => Promise<void>;
export function fixtureResultPipeline(repository: TaskRepository, verifier = (claim: LeaseClaim, actor: CommandActor, signal: AbortSignal): Promise<FixtureVerification> => verifyFixture(repository, claim, actor, signal)): AttemptFinalizer {
  return async (claim, _outcome, actor, signal) => {
    const evidence = await verifier(claim, actor, signal); signal.throwIfAborted();
    await repository.queue.completeFixture(claim, evidence, actor);
  };
}
/** Harness success preserves evidence but never substitutes for required engineering checks. */
export function verificationHandoffPipeline(repository: TaskRepository): AttemptFinalizer {
  return async (claim, outcome, actor, signal) => {
    const ids = outcome.artifactIds ?? [];
    if (!ids.length) throw new CtxError('CONFLICT', 'Verification handoff requires durable attempt evidence');
    for (const id of ids) {
      const artifact = await repository.verifyStoredArtifact(id);
      if (artifact.taskId !== claim.task.spec.id || artifact.attemptId !== claim.attempt.id) throw new CtxError('CONFLICT', 'Verification evidence belongs to another attempt');
    }
    signal.throwIfAborted();
    repository.queue.blockVerificationHandoff(claim, actor, { reason: 'Harness turn finished; required independent engineering verification is pending', artifactIds: ids });
  };
}

export function engineeringResultPipeline(repository: TaskRepository, options: VerificationOptions = {}, recovery?: Partial<RecoveryPolicy>): AttemptFinalizer {
  return async (claim, _outcome, actor, signal) => {
    if (recovery) {
      const remaining = recoveryPolicy(recovery).maxElapsedMs - (Date.now() - Date.parse(repository.queue.attempts(claim.task.spec.id)[0].startedAt));
      if (remaining <= 0) throw new CtxError('BUDGET_EXHAUSTED', 'Aggregate recovery time budget reached before verification');
      signal = AbortSignal.any([signal, AbortSignal.timeout(remaining)]);
    }
    const report = await verifyEngineeringAttempt(repository, claim, actor, signal, options);
    if (recovery) await writeRecoveryCheckpoint(repository, claim, report, recoveryPolicy(recovery), actor);
    await repository.queue.finalizeVerification(claim, report.id, actor);
  };
}
