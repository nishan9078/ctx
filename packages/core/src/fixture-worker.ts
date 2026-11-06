import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { open, rename, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import type { CommandActor } from '../../shared/src/domain.js';
import type { FixtureVerification, LeaseClaim, QueueWorker, WorkerOutcome } from '../../shared/src/scheduling.js';
import { fixtureAcceptance } from '../../shared/src/scheduling.js';
import { CtxError } from '../../shared/src/errors.js';
import { integer, record } from '../../shared/src/validation.js';
import { ordinaryDirectory, readJsonFile, sha256, syncPath } from '../../persistence/src/artifact-files.js';
import { ArtifactStore } from '../../persistence/src/artifact-store.js';
import type { TaskRepository } from '../../persistence/src/task-repository.js';
export type FixtureStep = { outcome: 'success' | 'failed' | 'capacity' | 'approval'; sleepMs?: number; retryable?: boolean; retryDelayMs?: number; corruptReceipt?: boolean };
export const fixtureReceiptPath = (root: string, claim: LeaseClaim): string => join(root, 'fixture-work', `${sha256(JSON.stringify([claim.task.spec.projectId, claim.task.spec.id]))}.json`);
/** Deterministic local fixture only. Never edits the registered source project or starts an LLM. */
export class FixtureWorker implements QueueWorker {
  readonly kind = 'fixture' as const;
  constructor(private readonly root: string, private readonly scripts: Record<string, FixtureStep[]> = {}, private readonly hooks: { started?: (claim: LeaseClaim) => void | Promise<void>; wrote?: (claim: LeaseClaim) => void | Promise<void> } = {}) {}
  async execute({ claim, signal }: { claim: LeaseClaim; signal: AbortSignal }): Promise<WorkerOutcome> {
    const script = this.scripts[claim.task.spec.id]; const step = script?.[claim.attempt.sequence - 1] ?? script?.at(-1) ?? { outcome: 'success' };
    await this.hooks.started?.(claim); await delay(integer(step.sleepMs ?? 0, 0, 10000, 'fixture.sleepMs'), undefined, { signal });
    if (step.outcome === 'failed') return { kind: 'failed', reason: 'Injected deterministic fixture failure', retryable: step.retryable ?? false, delayMs: step.retryDelayMs ?? 100 };
    if (step.outcome === 'capacity') return { kind: 'capacity', reason: 'Simulated capacity wait; no provider call made', delayMs: step.retryDelayMs ?? 100 };
    if (step.outcome === 'approval') return { kind: 'approval', reason: 'Fixture requested an exact-action approval; no action was executed' };
    const path = fixtureReceiptPath(this.root, claim); await ordinaryDirectory(join(this.root, 'fixture-work'), true);
    try {
      const receipt = record(await readJsonFile(path, 1000000), 'fixture.receipt');
      if (receipt.taskId !== claim.task.spec.id || receipt.specHash !== sha256(JSON.stringify(claim.task.spec))) throw new CtxError('CONFLICT', 'Existing fixture receipt does not match this task; do not overwrite unknown work');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const temporary = `${path}.${claim.attempt.id}.tmp`; const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify({ schemaVersion: 1, taskId: claim.task.spec.id, objective: claim.task.spec.objective, specHash: step.corruptReceipt ? 'incorrect' : sha256(JSON.stringify(claim.task.spec)), executionId: randomUUID() }) + '\n'); await handle.sync(); }
      finally { await handle.close(); }
      try { signal.throwIfAborted(); await rename(temporary, path); await syncPath(join(this.root, 'fixture-work')); } finally { await rm(temporary, { force: true }); }
    }
    await this.hooks.wrote?.(claim); signal.throwIfAborted(); return { kind: 'success' };
  }
}
/** Separate verifier reads actual deterministic output, rather than trusting worker success. */
export async function verifyFixture(repository: TaskRepository, claim: LeaseClaim, actor: CommandActor, signal: AbortSignal): Promise<FixtureVerification> {
  const project = repository.getProject(claim.task.spec.projectId);
  if (project.policyId !== 'fixture-only' || project.verificationProfile !== 'fixture-v1' || JSON.stringify(claim.task.spec.acceptance) !== JSON.stringify([fixtureAcceptance])) throw new CtxError('UNAUTHORIZED', 'Fixture verifier cannot complete ordinary engineering tasks');
  signal.throwIfAborted(); const receipt = record(await readJsonFile(fixtureReceiptPath(repository.dataDirectory, claim), 1000000), 'fixture.receipt');
  if (receipt.schemaVersion !== 1 || receipt.taskId !== claim.task.spec.id || receipt.objective !== claim.task.spec.objective || receipt.specHash !== sha256(JSON.stringify(claim.task.spec)) || typeof receipt.executionId !== 'string') throw new CtxError('TEST_FAILED', 'Independent fixture output verification failed');
  const store = await ArtifactStore.open(repository.dataDirectory);
  const result = await store.writeText({ taskId: claim.task.spec.id, attemptId: claim.attempt.id, kind: 'fixture-result' }, JSON.stringify(receipt), repository, actor);
  signal.throwIfAborted();
  const report = await store.writeText({ taskId: claim.task.spec.id, attemptId: claim.attempt.id, kind: 'fixture-report' }, JSON.stringify({ fixtureOnly: true, status: 'passed', taskId: claim.task.spec.id, attemptId: claim.attempt.id, resultSha256: result.sha256, limitations: ['Deterministic fixture output only; no live harness, code patch or provider verification.'] }), repository, actor);
  signal.throwIfAborted(); return { resultArtifactId: result.id, reportArtifactId: report.id };
}
