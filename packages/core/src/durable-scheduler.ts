import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { CommandActor } from '../../shared/src/domain.js';
import type { FixtureVerification, LeaseClaim, QueueStatus, QueueWorker, WorkerOutcome } from '../../shared/src/scheduling.js';
import { CtxError } from '../../shared/src/errors.js';
import { integer } from '../../shared/src/validation.js';
import type { TaskRepository } from '../../persistence/src/task-repository.js';
import { fixtureResultPipeline, type AttemptFinalizer } from './result-pipeline.js';
interface Active { claim: LeaseClaim; abort: AbortController; promise: Promise<void> }
export class DurableScheduler {
  readonly ownerId = randomUUID();
  readonly #active = new Map<string, Active>();
  readonly #actor: CommandActor;
  readonly #leaseMs: number;
  #stopping = false;
  #lastError?: string;
  constructor(private readonly repository: TaskRepository, private readonly worker: QueueWorker, options: { leaseMs?: number; finalizer?: AttemptFinalizer; onReconcile?: (actor: CommandActor) => Promise<void>; onWorkerSettled?: (claim: LeaseClaim, outcome: WorkerOutcome, actor: CommandActor, signal: AbortSignal) => Promise<void>; verifier?: (claim: LeaseClaim, actor: CommandActor, signal: AbortSignal) => Promise<FixtureVerification> } = {}) {
    this.#leaseMs = integer(options.leaseMs ?? 5000, 100, 60000, 'leaseMs'); this.#actor = { actorId: 'scheduler', source: 'local', requestId: this.ownerId };
    this.onReconcile = options.onReconcile;
    this.onWorkerSettled = options.onWorkerSettled;
    this.finalize = options.finalizer ?? fixtureResultPipeline(repository, options.verifier);
  }
  private readonly finalize: AttemptFinalizer;
  private readonly onReconcile?: (actor: CommandActor) => Promise<void>;
  private readonly onWorkerSettled?: (claim: LeaseClaim, outcome: WorkerOutcome, actor: CommandActor, signal: AbortSignal) => Promise<void>;
  get activeCount(): number { return this.#active.size; }
  get lastError(): string | undefined { return this.#lastError; }
  tick(): number {
    if (this.#stopping) return 0;
    this.repository.queue.reconcile(this.#actor); this.repository.queue.refresh(this.#actor); let started = 0;
    for (;;) {
      const claim = this.repository.queue.claim({ ownerId: this.ownerId, workerKind: this.worker.kind, leaseMs: this.#leaseMs }, this.#actor); if (!claim) break;
      const abort = new AbortController();
      const promise = this.execute(claim, abort).catch(error => { this.#lastError = error instanceof CtxError ? error.message : 'Scheduler lifecycle failure; inspect durable state'; }).finally(() => this.#active.delete(claim.attempt.id));
      this.#active.set(claim.attempt.id, { claim, abort, promise }); started++;
    }
    return started;
  }
  private async execute(claim: LeaseClaim, abort: AbortController): Promise<void> {
    const heartbeat = setInterval(() => {
      try { if (this.repository.queue.heartbeat(claim, this.#leaseMs) === 'cancel') abort.abort(new Error('Owner cancelled task')); }
      catch { abort.abort(new Error('Lease no longer permits worker activity')); }
    }, Math.max(10, Math.min(1000, Math.floor(this.#leaseMs / 3))));
    const timeout = setTimeout(() => abort.abort(new Error('Task attempt wall-time budget reached')), claim.task.spec.maxWallMinutes * 60_000);
    let invoked = false; let reported = false;
    try {
      this.repository.queue.start(claim, this.#actor);
      invoked = true;
      const outcome = await this.worker.execute({ claim: structuredClone(claim), signal: abort.signal });
      if (abort.signal.aborted) { await this.onWorkerSettled?.(claim, outcome, this.#actor, abort.signal); reported = true; this.repository.queue.stopped(claim, this.#actor, 'Worker quiesced after cancellation, shutdown or lease loss'); return; }
      if (outcome.kind !== 'success') { await this.onWorkerSettled?.(claim, outcome, this.#actor, abort.signal); reported = true; this.repository.queue.settle(claim, outcome, this.#actor); return; }
      this.repository.queue.beginVerification(claim, this.#actor);
      await this.finalize(claim, outcome, this.#actor, abort.signal);
    } catch (error) {
      if (!invoked) {
        try { this.repository.queue.stopped(claim, this.#actor, 'Worker invocation never began; failed start is safely quiescent'); } catch (stale) { if (!(stale instanceof CtxError && stale.code === 'CONFLICT')) throw stale; }
        return;
      }
      if (!reported && this.onWorkerSettled) {
        try { await this.onWorkerSettled(claim, { kind: 'failed', reason: error instanceof CtxError ? error.message : 'Worker lifecycle failed', retryable: false }, this.#actor, abort.signal); }
        catch (reportError) { if (!(reportError instanceof CtxError && reportError.code === 'CONFLICT')) this.#lastError = 'Attempt report unavailable; inspect durable lifecycle and evidence'; }
      }
      // Worker execute/verification has settled before any release. An ignored signal keeps its slot.
      if (abort.signal.aborted || error instanceof CtxError && error.code === 'CANCELLED') {
        try { this.repository.queue.stopped(claim, this.#actor, 'Worker quiesced; stale owner cannot write after release'); } catch (stale) { if (!(stale instanceof CtxError && stale.code === 'CONFLICT')) throw stale; }
      } else {
        try { this.repository.queue.settle(claim, { kind: 'failed', reason: error instanceof CtxError ? error.message : 'Worker failed before producing verified output', retryable: false }, this.#actor); }
        catch (lost) {
          if (!(lost instanceof CtxError && lost.code === 'CONFLICT')) throw lost;
          try { this.repository.queue.stopped(claim, this.#actor, 'Quiescent worker lost its lease during finalization'); } catch (stale) { if (!(stale instanceof CtxError && stale.code === 'CONFLICT')) throw stale; }
        }
      }
    } finally { clearInterval(heartbeat); clearTimeout(timeout); }
  }
  async runUntilIdle(options: { waitForDeadlines?: boolean; timeoutMs?: number } = {}): Promise<QueueStatus> {
    await this.onReconcile?.(this.#actor);
    const end = Date.now() + integer(options.timeoutMs ?? 10000, 1, 60000, 'timeoutMs');
    for (;;) {
      this.tick(); const status = this.repository.queue.status();
      if (!this.#active.size) {
        if (!options.waitForDeadlines || status.configuration.paused || !status.nextRunAt) { await this.onReconcile?.(this.#actor); const refreshed = this.repository.queue.status(); if (options.waitForDeadlines && !refreshed.configuration.paused && refreshed.nextRunAt) continue; return refreshed; }
        await delay(Math.min(50, Math.max(1, Date.parse(status.nextRunAt) - Date.now())));
      } else await Promise.race([...this.#active.values()].map(active => active.promise).concat(delay(20)));
      if (Date.now() >= end) throw new CtxError('TIMEOUT', 'Observation deadline reached; active workers remain managed until stopped or completed');
    }
  }
  async shutdown(): Promise<void> {
    this.#stopping = true;
    for (const active of this.#active.values()) active.abort.abort(new Error('Scheduler shutdown'));
    await Promise.allSettled([...this.#active.values()].map(active => active.promise));
  }
}
