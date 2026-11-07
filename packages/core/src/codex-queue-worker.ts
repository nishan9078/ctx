import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { CommandActor } from '../../shared/src/domain.js';
import type { LeaseClaim, QueueWorker, WorkerOutcome } from '../../shared/src/scheduling.js';
import { CtxError } from '../../shared/src/errors.js';
import { probeCodex, type CodexReadiness } from '../../agents/src/codex-probe.js';
import { buildCodexTaskPacket, formatCodexPrompt } from '../../agents/src/codex-task-packet.js';
import { normalizeCodexEvent, CodexTurnTracker } from '../../agents/src/codex-event-normalizer.js';
import type { CodexExecutor } from '../../agents/src/codex-execution-port.js';
import { workspaceTree } from '../../environment/src/workspace-tree.js';
import { privateGit } from '../../environment/src/private-git.js';
import { captureDiff } from '../../environment/src/workspace.js';
import { ArtifactStore } from '../../persistence/src/artifact-store.js';
import { sha256 } from '../../persistence/src/artifact-files.js';
import type { TaskRepository } from '../../persistence/src/task-repository.js';
import { SupervisedCodexExecutor } from './supervised-codex-executor.js';
import { DurableScheduler } from './durable-scheduler.js';
import { OwnedWorkspaces } from './owned-workspaces.js';
import type { OwnedWorkspace } from '../../shared/src/workspaces.js';
import { RuntimeSampler, enforceRuntimeBudget } from '../../environment/src/runtime-health.js';
import { workerRuntimeBudget, type WorkerRuntimeBudget } from '../../shared/src/runtime.js';
import { verifyEngineeringAttempt, reconcileVerificationReports, type VerificationOptions } from './engineering-verification.js';
import { engineeringResultPipeline } from './result-pipeline.js';
export interface CodexQueueOptions {
  executor?: CodexExecutor;
  probe?: () => Promise<CodexReadiness>;
  model?: string;
  runtime?: Partial<WorkerRuntimeBudget>;
  verification?: VerificationOptions;
  /** Explicit owner-selected prior attempt. Never inferred from a crash. */
  resume?: { taskId: string; attemptId: string };
}
export class CodexQueueWorker implements QueueWorker {
  readonly kind = 'codex' as const;
  constructor(private readonly repository: TaskRepository, private readonly options: CodexQueueOptions = {}) {}
  async execute({ claim, signal }: { claim: LeaseClaim; signal: AbortSignal }): Promise<WorkerOutcome> {
    const actor: CommandActor = { actorId: 'codex-worker', source: 'local', requestId: claim.attempt.id };
    const store = await ArtifactStore.open(this.repository.dataDirectory);
    const artifacts: string[] = []; const evidence: string[] = []; let delivery = 0; let rawCount = 0; let workspace: string | undefined; let workspaceOwnerAttemptId = claim.attempt.id; let effectsPossible = false; let processStarted = false;
    const tracker = new CodexTurnTracker();
    const manager = new OwnedWorkspaces(this.repository); const budget = workerRuntimeBudget(this.options.runtime); let owned: OwnedWorkspace | undefined;
    const save = async (kind: string, content: string, retention: 'log' | 'evidence' = 'evidence') => {
      const artifact = await store.writeText({ taskId: claim.task.spec.id, attemptId: claim.attempt.id, kind, retention }, content, this.repository, actor);
      artifacts.push(artifact.id); if (!['codex-raw-log', 'codex-command'].includes(kind)) evidence.push(artifact.id); return artifact.id;
    };
    const emit = (type: string, payload: unknown, kind: 'canonical' | 'diagnostic' = 'canonical') => {
      this.repository.queue.appendWorkerEvent(claim, { kind, type, payload: kind === 'canonical' ? { taskId: claim.task.spec.id, attemptId: claim.attempt.id, timestamp: new Date().toISOString(), type, ...payload as object } : payload, deliveryId: `worker-${++delivery}` });
    };
    const fail = (code: string, reason: string, retryable = false) => { emit('failed', { code, message: reason, retryable }); };
    try {
      signal.throwIfAborted();
      const frozen = this.repository.verification.bind(claim, actor);
      emit('runtime.budget', budget, 'diagnostic');
      const sampler = new RuntimeSampler(); const preflight = await sampler.sample(this.repository.dataDirectory);
      emit('runtime.health', preflight, 'diagnostic'); enforceRuntimeBudget(preflight, budget);
      const readiness = await (this.options.probe ?? probeCodex)();
      emit('preflight', readiness, 'diagnostic');
      this.repository.queue.recordHarnessMetadata(claim, { modelId: this.options.model ?? 'unknown' }, actor);
      if (!readiness.cliAvailable || readiness.sdkVersion === 'unknown') { fail('HARNESS_UNAVAILABLE', 'Codex CLI or SDK unavailable'); return { kind: 'blocked', reason: 'Codex CLI or SDK unavailable; inspect preflight diagnostics' }; }
      if (readiness.auth === 'none' || readiness.auth === 'unknown') { fail('AUTH_REQUIRED', 'Codex authentication is unavailable'); return { kind: 'blocked', reason: 'Codex authentication required' }; }
      let resumeSession: string | undefined;
      if (this.options.resume?.taskId === claim.task.spec.id) {
        const priorId = this.options.resume.attemptId;
        const prior = this.repository.queue.attempts(claim.task.spec.id).find(attempt => attempt.id === priorId);
        if (!prior || ['leased', 'running', 'verifying'].includes(prior.state) || prior.harnessId !== 'codex') throw new CtxError('CONFLICT', 'Resume requires a quiescent prior Codex attempt of this task');
        const descriptor = this.repository.artifacts(claim.task.spec.id).find(artifact => artifact.attemptId === priorId && artifact.kind === 'codex-workspace');
        if (!descriptor) throw new CtxError('CONFLICT', 'Resume workspace evidence is missing');
        await this.repository.verifyStoredArtifact(descriptor.id);
        const manifest = JSON.parse(await readFile(join(this.repository.dataDirectory, descriptor.location), 'utf8')) as { workspace: string; specHash: string; workspaceOwnerAttemptId?: string };
        workspaceOwnerAttemptId = manifest.workspaceOwnerAttemptId ?? priorId;
        if (!this.repository.queue.attempts(claim.task.spec.id).some(attempt => attempt.id === workspaceOwnerAttemptId && attempt.harnessId === 'codex')) throw new CtxError('CONFLICT', 'Resume workspace has no owning task attempt');
        workspace = join(this.repository.dataDirectory, 'codex-work', workspaceOwnerAttemptId, 'worktree');
        if (manifest.workspace !== workspace || manifest.specHash !== sha256(JSON.stringify(claim.task.spec)) || await realpath(workspace) !== workspace) throw new CtxError('CONFLICT', 'Resume requires the original unchanged task and retained workspace');
        resumeSession = this.repository.queue.session(priorId)?.externalSessionId ?? undefined;
        if (!resumeSession) throw new CtxError('CONFLICT', 'Resume thread ID is unavailable');
        owned = await manager.resume(claim, workspaceOwnerAttemptId, actor);
        if (owned.identity.worktree !== workspace) throw new CtxError('CONFLICT', 'Resume ownership path changed');
        tracker.sessionId = resumeSession;
      } else {
        owned = await manager.create(claim, actor, { signal, maxBytes: budget.maxWorkspaceBytes, onStage: async stage => {
          const health = await sampler.sample(this.repository.dataDirectory, join(this.repository.dataDirectory, 'codex-work', claim.attempt.id));
          emit('workspace.preparation', { stage, health }, 'diagnostic'); enforceRuntimeBudget(health, budget);
        } });
        workspace = owned.identity.worktree;
      }
      await save('codex-workspace', JSON.stringify({ workspace, workspaceOwnerAttemptId, baseSha: owned.identity.baseSha, branch: owned.identity.branch, taskId: claim.task.spec.id, attemptId: claim.attempt.id, specHash: sha256(JSON.stringify(claim.task.spec)), resumedFrom: this.options.resume?.taskId === claim.task.spec.id ? this.options.resume.attemptId : null }));
      await save('codex-task-packet', JSON.stringify(buildCodexTaskPacket(claim.task.spec)));
      if (resumeSession) this.repository.queue.recordSession(claim, { externalSessionId: resumeSession, version: readiness.sdkVersion });
      if (frozen.profile) {
        const unchanged = await privateGit(['diff', '--no-ext-diff', '--no-textconv', '--exit-code', owned.identity.baseSha!, '--'], owned.identity.snapshot, signal);
        if (unchanged.code !== 0) throw new CtxError('CONFLICT', 'Verification baseline changed before harness execution');
        const baseline = await workspaceTree(owned.identity.snapshot);
        const descriptor = await store.writeBinary({ taskId: claim.task.spec.id, attemptId: claim.attempt.id, kind: 'verification-baseline' }, Buffer.from(JSON.stringify({ schemaVersion: 1, workspaceId: owned.id, baseSha: owned.identity.baseSha, profileHash: frozen.profileHash, taskSpecHash: frozen.taskSpecHash, entries: baseline.entries })), this.repository, actor); evidence.push(descriptor.id);
      }
      const executor = this.options.executor ?? new SupervisedCodexExecutor({ runtime: budget });
      const result = await executor.run({ prompt: formatCodexPrompt(buildCodexTaskPacket(claim.task.spec)), workspacePath: workspace, resourceRoot: owned.identity.root, runtimeBudget: budget, onHealth: health => emit('runtime.health', health, 'diagnostic'), sessionId: resumeSession, model: this.options.model, signal,
        onProcess: info => {
          processStarted = true;
          this.repository.queue.recordWorkerProcess(claim, info);
          emit('started', { harnessId: 'codex', ...(resumeSession ? { sessionId: resumeSession } : {}) });
        },
        onRawEvent: async raw => {
          if (++rawCount > 10000) throw new CtxError('BUDGET_EXHAUSTED', 'Attempt event count exceeds 10000');
          // Each raw segment is immutable and fsynced before acknowledging the SDK host.
          const rawArtifact = await save('codex-raw-log', JSON.stringify(raw) + '\n', 'log');
          emit('raw', { artifactId: rawArtifact, ordinal: rawCount }, 'diagnostic');
          const normalized = await normalizeCodexEvent(raw, { taskId: claim.task.spec.id, attemptId: claim.attempt.id, sequence: 0, timestamp: new Date().toISOString() }, tracker, {
            persistCommandOutput: async command => ({ artifactId: await save('codex-command', JSON.stringify(command), 'log') }),
          });
          if (tracker.sessionId) this.repository.queue.recordSession(claim, { externalSessionId: tracker.sessionId, version: readiness.sdkVersion });
          if (normalized.kind === 'events') for (const event of normalized.events) {
            if (['tool_started', 'tool_completed', 'command_executed', 'files_changed'].includes(event.type)) effectsPossible = true;
            emit(event.type, event);
          }
          else if (normalized.kind === 'diagnostic') emit(normalized.type, normalized.payload, 'diagnostic');
        },
      });
      await save('codex-process-result', JSON.stringify(result), 'log');
      await save('codex-diff', await captureDiff(workspace, owned?.identity.baseSha));
      try { const archived = await manager.archive(owned.id, actor, claim); if (archived.archiveArtifactId) evidence.push(archived.archiveArtifactId); }
      catch (error) { if (!(error instanceof CtxError && error.code === 'BUDGET_EXHAUSTED')) throw error; emit('workspace.archive_unavailable', { reason: error.message, retained: true }, 'diagnostic'); }
      await save('codex-result', JSON.stringify({ sessionId: tracker.sessionId, summary: tracker.summary, usage: tracker.usage, terminal: tracker.terminal(), malformed: tracker.malformed, toolErrors: tracker.sawToolError, workspace, model: this.options.model ?? 'unknown', provider: 'unknown' }));
      if (signal.aborted || result.aborted) { emit('interrupted', { reason: 'Worker stopped after cancellation' }); return { kind: 'blocked', reason: 'Worker interrupted' }; }
      if (result.exitCode === 0 && tracker.terminal() === 'completed') {
        await save('harness-result', JSON.stringify({ schemaVersion: 1, taskId: claim.task.spec.id, attemptId: claim.attempt.id, taskSpecHash: sha256(JSON.stringify(claim.task.spec)), harnessId: this.kind, outcome: 'completed', exitCode: result.exitCode, sessionId: tracker.sessionId }));
        emit('completed', { summary: tracker.summary || 'Codex turn completed', artifactIds: evidence });
        return { kind: 'success', artifactIds: evidence };
      }
      const message = (tracker.errorMessage || result.stderrTail || 'Codex exited without a valid completed turn').slice(0, 4000);
      if (/auth|unauthorized|log.?in|401|403/i.test(message)) { fail('AUTH_REQUIRED', message); return { kind: 'blocked', reason: 'Codex authentication or authorization failed; inspect attempt log' }; }
      if (!effectsPossible && /rate.?limit|too many requests|\b429\b/i.test(message)) { fail('RATE_LIMIT', message, true); return { kind: 'capacity', reason: 'Codex explicitly reported a rate limit before observable tool activity', delayMs: 1000 }; }
      fail('HARNESS_UNAVAILABLE', message);
      return { kind: 'blocked', reason: 'Codex did not complete reliably; retained workspace requires reconciliation' };
    } catch (error) {
      if (error instanceof CtxError && error.code === 'CONFLICT') throw error;
      await save('codex-error', String(error).slice(0, 16000), 'log');
      if (workspace) await save('codex-diff', await captureDiff(workspace, owned?.identity.baseSha));
      if (owned) { try { await manager.archive(owned.id, actor, claim); } catch (archiveError) { if (!(archiveError instanceof CtxError && archiveError.code === 'BUDGET_EXHAUSTED')) throw archiveError; emit('workspace.archive_unavailable', { retained: true }, 'diagnostic'); } }
      if (signal.aborted) {
        emit('interrupted', { reason: 'Cancelled; executor quiesced' });
        return { kind: 'blocked', reason: 'Codex execution interrupted' };
      }
      const reason = error instanceof CtxError ? error.message : 'Codex execution or environment failed; inspect retained workspace and events';
      const safeSpawnRetry = !processStarted && !effectsPossible && ['EAGAIN', 'EMFILE', 'ENFILE'].includes((error as NodeJS.ErrnoException).code ?? '');
      fail(error instanceof CtxError ? error.code : 'HARNESS_UNAVAILABLE', reason, safeSpawnRetry);
      return safeSpawnRetry ? { kind: 'failed', reason, retryable: true, delayMs: 1000 } : { kind: 'blocked', reason };
    }
  }
}
export function createCodexQueueScheduler(repository: TaskRepository, options: CodexQueueOptions & { leaseMs?: number } = {}): DurableScheduler {
  return new DurableScheduler(repository, new CodexQueueWorker(repository, options), { leaseMs: options.leaseMs, finalizer: engineeringResultPipeline(repository, { runtime: options.runtime, ...options.verification }),
    async onReconcile(actor) { await reconcileVerificationReports(repository, actor); },
    async onWorkerSettled(claim, outcome, actor, signal) {
      if (repository.verification.reports(claim.task.spec.id).some(report => report.attemptId === claim.attempt.id && report.reportArtifactId)) return;
      await verifyEngineeringAttempt(repository, claim, actor, signal, { runtime: options.runtime, ...options.verification }, { harnessOutcome: signal.aborted ? 'interrupted' : 'failed', reason: outcome.kind === 'success' ? 'Worker interrupted before verification' : outcome.reason });
    },
  });
}
