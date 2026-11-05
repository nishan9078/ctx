import { EnvironmentManager, createEnvironmentState } from '../../environment/src/environment-manager.js';
import { detectEnvironment } from '../../environment/src/service-detector.js';
import { EnvironmentUnavailable, type DockerDriver, type EnvironmentOptions } from '../../environment/src/types.js';
import { redact } from '../../shared/src/redact.js';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile, readFile, rename, realpath, access } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentAdapter, AgentResult } from '../../agents/src/agent-adapter.js';
import type { Report } from '../../shared/src/contracts.js';
import type { TaskRecord, TaskStatus, Attempt } from './types.js';
import { prepareWorkspace, captureDiff } from '../../environment/src/workspace.js';
import { discoverCommands, verify } from '../../verification/src/verifier.js';
import { TaskStore } from '../../persistence/src/database.js';
import { createPlan, validatePlan } from './planner.js';
import { nextStep } from './scheduler.js';
import { recoveryProblem } from './recovery.js';
import { terminal } from './state-machine.js';
export interface RunInput {
  request: string; repositoryPath: string; outputDirectory?: string;
  build?: string; test?: string; signal?: AbortSignal; timeoutMs?: number;
  plan?: unknown; maxRepairAttempts?: number; model?: string;
  leaseDurationMs?: number; environment?: EnvironmentOptions;
}
export interface ResumeInput { id: string; outputDirectory: string; signal?: AbortSignal; leaseDurationMs?: number }
export function databasePath(outputDirectory: string): string { return join(resolve(outputDirectory), 'harness.sqlite'); }
export async function runTask(input: RunInput, agent: AgentAdapter, dependencies: { docker?: DockerDriver } = {}): Promise<{ report: Report; directory: string }> {
  if (!input.request.trim()) throw new Error('Request must not be empty');
  const timeoutMs = input.timeoutMs ?? 600_000; const maxRepairAttempts = input.maxRepairAttempts ?? 0;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) throw new Error('Invalid timeout');
  if (!Number.isInteger(maxRepairAttempts) || maxRepairAttempts < 0 || maxRepairAttempts > 10) throw new Error('Repair budget must be an integer from 0 to 10');
  const plan = input.plan === undefined ? createPlan(redact(input.request)) : validatePlan(JSON.parse(redact(JSON.stringify(input.plan))));
  const repositoryPath = await realpath(input.repositoryPath);
  const root = resolve(input.outputDirectory ?? join(repositoryPath, '.harness'));
  await mkdir(root, { recursive: true });
  const id = randomUUID(); const directory = join(root, id); const now = new Date().toISOString();
  const commands = await discoverCommands(repositoryPath, input);
  const config = await detectEnvironment(repositoryPath, input.environment);
  const store = new TaskStore(databasePath(root));
  try {
    store.create({ id, request: redact(input.request), repositoryPath, directory,
      workspacePath: join(tmpdir(), `harness-${id}`, 'workspace'), status: 'queued', createdAt: now, updatedAt: now,
      plan, commands, prepared: false, environment: createEnvironmentState(id, config), maxRepairAttempts, remainingRepairAttempts: maxRepairAttempts,
      attempts: [], verification: [], timeoutMs, elapsedMs: 0, model: input.model });
  } finally { store.close(); }
  return executeTask({ id, outputDirectory: root, signal: input.signal, leaseDurationMs: input.leaseDurationMs }, agent, false, dependencies);
}
export async function resumeTask(input: ResumeInput, agent: AgentAdapter, dependencies: { docker?: DockerDriver } = {}): Promise<{ report: Report; directory: string }> {
  await access(databasePath(input.outputDirectory));
  return executeTask(input, agent, true, dependencies);
}
function validResult(result: AgentResult): void {
  if (!result || !['completed', 'failed', 'interrupted'].includes(result.outcome) || typeof result.summary !== 'string'
    || (result.sessionId !== undefined && (typeof result.sessionId !== 'string' || !result.sessionId))
    || (result.usage !== undefined && (!result.usage || typeof result.usage !== 'object' || Object.values(result.usage).some(value => typeof value !== 'number' || value < 0 || !Number.isFinite(value))))) throw new Error('Invalid agent result');
}
async function executeTask(input: ResumeInput, agent: AgentAdapter, recovering: boolean, dependencies: { docker?: DockerDriver }): Promise<{ report: Report; directory: string }> {
  const leaseMs = input.leaseDurationMs ?? 5000;
  if (!Number.isInteger(leaseMs) || leaseMs < 100 || leaseMs > 60_000) throw new Error('Invalid lease duration');
  const store = new TaskStore(databasePath(input.outputDirectory));
  let owner: string;
  try { owner = store.claim(input.id, leaseMs); } catch (error) { store.close(); throw error; }
  let task = store.get(input.id); const started = Date.now(); const alreadyTerminal = terminal(task.status);
  const controller = new AbortController(); const abort = () => controller.abort(input.signal?.reason);
  input.signal?.addEventListener('abort', abort, { once: true }); if (input.signal?.aborted) abort();
  let leaseError: unknown;
  const heartbeat = setInterval(() => { try { store.heartbeat(task.id, owner, leaseMs); } catch (error) { leaseError = error; controller.abort(error); } }, Math.max(25, Math.floor(leaseMs / 3)));
  const remainingMs = task.timeoutMs - Math.max(task.elapsedMs, Date.now() - Date.parse(task.createdAt));
  if (remainingMs <= 0) controller.abort(new Error('Task timed out'));
  const timer = setTimeout(() => controller.abort(new Error('Task timed out')), Math.max(1, remainingMs));
  const update = (type: string, data: unknown, mutate: (current: TaskRecord) => void = () => {}) => {
    if (leaseError) throw leaseError;
    task = store.update(task.id, owner, type, data, mutate);
  };
  const transition = (status: TaskStatus, mutate: (current: TaskRecord) => void = () => {}) => update(`task.${status}`, { status }, current => { current.status = status; mutate(current); });
  const environment = task.environment ? new EnvironmentManager(task.id, task.workspacePath, task.directory, {
    get: () => task.environment!,
    update: (type, data, mutate) => {
      update(type, data, current => { mutate(current.environment!); });
      if (type === 'environment.recovery.result') {
        const artifact = task.environment!.recoveries.at(-1)!.artifact;
        store.artifact(task.id, owner, artifact, sha(readFileSync(artifact)), 'environment-recovery');
      }
    },
  }, dependencies.docker) : undefined;
  const concludeAttempt = (attemptId: string, result: AgentResult) => {
    validResult(result);
    update('agent.result', result, current => {
      const attempt = current.attempts.find(item => item.id === attemptId)!;
      attempt.result = { ...result, summary: redact(result.summary) }; attempt.sessionId = result.sessionId ?? attempt.sessionId;
      attempt.status = result.outcome; attempt.finishedAt = new Date().toISOString();
      current.plan.steps.find(step => step.id === attempt.stepId)!.status = result.outcome === 'completed' ? 'passed' : 'failed';
    });
  };
  try {
    await mkdir(task.directory, { recursive: true });
    if (!terminal(task.status) && controller.signal.aborted) transition(input.signal?.aborted ? 'cancelled' : 'failed', current => { current.error = 'Cancelled or timed out before execution'; });
    if (recovering && !terminal(task.status)) {
      update('task.reconciling', { status: task.status, workspacePath: task.workspacePath });
      let problem = recoveryProblem(task);
      if (task.prepared) {
        try { await access(join(task.workspacePath, '.git')); }
        catch { problem = 'Retained workspace is missing; automatic recreation would discard task changes.'; }
      }
      for (const check of task.verification) {
        const artifact = store.db.prepare('SELECT checksum FROM artifacts WHERE task_id=? AND path=?').get(task.id, check.artifact) as { checksum: string } | undefined;
        try { if (!artifact || sha(await readFile(check.artifact)) !== artifact.checksum) problem = `Verification artifact missing or changed: ${check.artifact}`; }
        catch { problem = `Verification artifact missing: ${check.artifact}`; }
      }
      if (problem) transition('blocked', current => { current.error = problem; for (const step of current.plan.steps) if (step.status === 'running') step.status = 'blocked'; });
      else {
        for (const step of task.plan.steps.filter(item => item.status === 'running')) {
          const attempt = task.attempts.findLast(item => item.stepId === step.id)!;
          concludeAttempt(attempt.id, attempt.result!);
          update('attempt.reconciled', { attemptId: attempt.id, sessionId: attempt.sessionId });
          if (attempt.result!.outcome !== 'completed') transition('failed', current => { current.error = attempt.result!.summary; });
        }
      }
    }
    if (task.status === 'queued') transition('planning');
    if (task.status === 'planning') {
      // The runtime-validated plan and commands were persisted before any execution.
      update('plan.accepted', { version: task.plan.version, steps: task.plan.steps.map(step => step.id) });
      transition('preparing');
      await mkdir(dirname(task.workspacePath), { recursive: true });
      await prepareWorkspace(task.repositoryPath, task.workspacePath);
      update('workspace.prepared', { path: task.workspacePath }, current => { current.prepared = true; });
    }
    if (!terminal(task.status) && environment) await environment.prepare(controller.signal);
    if (task.status === 'preparing') transition('executing');
    while (!terminal(task.status)) {
      if (controller.signal.aborted) { transition(input.signal?.aborted ? 'cancelled' : 'failed', current => { current.error = 'Task cancelled or timed out'; }); break; }
      if (task.status === 'repairing') transition('executing');
      if (task.status === 'executing') {
        const step = nextStep(task.plan);
        if (step) {
          const previous = task.attempts.findLast(item => item.stepId === step.id);
          const attempt: Attempt = { id: randomUUID(), stepId: step.id, idempotencyKey: `${task.id}:${task.plan.version}:${step.id}:${task.attempts.length}`, status: 'running', startedAt: new Date().toISOString(), sessionId: previous?.sessionId };
          update('attempt.intent', { attemptId: attempt.id, idempotencyKey: attempt.idempotencyKey, stepId: step.id }, current => { current.attempts.push(attempt); current.plan.steps.find(item => item.id === step.id)!.status = 'running'; });
          const result = await agent.execute({ workspacePath: task.workspacePath, sessionId: attempt.sessionId, signal: controller.signal,
            prompt: `Implement this task step in the current workspace.\nRequest: ${task.request}\nStep: ${step.title}\n${step.instructions}\nAcceptance criteria: ${JSON.stringify(step.acceptanceCriteria)}\nVerification: ${JSON.stringify(task.commands)}\n${task.error ? `Repair the concrete verification failures: ${task.error}` : ''}\nThe harness performs independent verification using its configured execution backend. Do not change application behavior to hide unavailable services, dependencies, or credentials; report those failures for deterministic environment recovery. Preserve existing work. Do not deploy, contact external services, use credentials, modify files outside the workspace, commit, or change Git metadata. Summarize changes and limitations.`,
            onEvent: async item => {
              update(`agent.${item.type}`, item.data, current => {
                const active = current.attempts.find(value => value.id === attempt.id)!;
                const data = item.data as { thread_id?: unknown; item?: { type?: string; text?: unknown }; usage?: Record<string, number>; error?: { message?: string }; message?: string } | null;
                if (item.type === 'thread.started') {
                  if (!data || typeof data.thread_id !== 'string' || !data.thread_id) throw new Error('Invalid session event');
                  active.sessionId = data.thread_id;
                }
                if (item.type === 'item.completed' && data?.item?.type === 'agent_message') {
                  if (typeof data.item.text !== 'string') throw new Error('Invalid agent message');
                  active.summary = redact(data.item.text);
                }
                if (item.type === 'turn.completed') {
                  const completed: AgentResult = { outcome: 'completed', sessionId: active.sessionId, summary: active.summary ?? 'Completed SDK turn recovered from journal', usage: data?.usage };
                  validResult(completed); active.result = completed;
                }
                if (item.type === 'turn.failed' || item.type === 'error') active.result = { outcome: 'failed', sessionId: active.sessionId, summary: redact(data?.error?.message ?? data?.message ?? 'Agent stream failed') };
              });
            },
          });
          concludeAttempt(attempt.id, result);
          if (result.outcome !== 'completed') transition(result.outcome === 'interrupted' && input.signal?.aborted ? 'cancelled' : 'failed', current => { current.error = redact(result.summary); });
          continue;
        }
        if (!task.plan.steps.every(item => item.status === 'passed')) { transition('blocked', current => { current.error = 'No schedulable step; dependencies have not passed'; }); continue; }
        transition('verifying');
      }
      if (task.status === 'verifying') {
        const round = task.environment?.verificationRound ?? task.maxRepairAttempts - task.remainingRepairAttempts;
        const verificationDirectory = round === 0 ? task.directory : join(task.directory, `verification-${round}`);
        await mkdir(verificationDirectory, { recursive: true });
        await verify(task.workspacePath, verificationDirectory, task.commands, controller.signal, task.timeoutMs, {
          existing: task.verification,
          before: name => update('verification.intent', { name }, current => { current.activeCheck = name; }),
          after: check => {
            store.artifact(task.id, owner, check.artifact, sha(readFileSync(check.artifact)), check.name);
            update('verification.result', check, current => { current.verification.push(check); delete current.activeCheck; });
          },
        }, environment);
        if (controller.signal.aborted) { transition(input.signal?.aborted ? 'cancelled' : 'failed', current => { current.error = 'Task cancelled or timed out'; }); continue; }
        if (task.verification.every(check => check.status === 'passed')) {
          const diff = await captureDiff(task.workspacePath);
          controller.signal.throwIfAborted();
          const path = join(task.directory, 'changes.diff');
          await atomicWrite(path, diff); store.artifact(task.id, owner, path, sha(diff), 'diff');
          transition('completed');
        }
        else if (task.verification.some(check => check.status === 'unavailable')) transition('blocked', current => { current.error = 'Required verification command unavailable'; });
        else {
          const recovery = await environment?.recover(task.verification, controller.signal) ?? 'not-applicable';
          controller.signal.throwIfAborted();
          if (recovery === 'recovered') {
            update('verification.retry', { reason: 'verified environment recovery' }, current => { current.verification = []; current.environment!.verificationRound++; });
            continue;
          }
          if (recovery === 'blocked') { transition('blocked', current => { current.error = current.environment?.limitations.at(-1) ?? 'Environment recovery could not be verified'; }); continue; }
          if (task.remainingRepairAttempts > 0) {
            const evidence = task.verification.filter(check => check.status !== 'passed').map(check => `${check.name}: ${check.command}, exit ${check.exitCode}\n${redact(readFileSync(check.artifact, 'utf8')).slice(-20_000)}`).join('\n');
            if (evidence === task.error) { transition('failed', current => { current.error = `Repeated identical verification failure; no further automatic repair.\n${evidence}`; }); continue; }
            transition('repairing', current => {
              current.remainingRepairAttempts--; current.error = evidence; current.verification = [];
              if (current.environment) current.environment.verificationRound++;
              // Repair only the final workstream, preserving all passed prerequisite steps.
              current.plan.steps.findLast(step => step.status === 'passed')!.status = 'pending';
            });
          } else transition('failed', current => { current.error = 'Verification failed; repair budget exhausted'; });
        }
      }
    }
  } catch (error) {
    if (leaseError) throw leaseError;
    if (!terminal(task.status)) transition(controller.signal.aborted && input.signal?.aborted ? 'cancelled' : error instanceof EnvironmentUnavailable ? 'blocked' : 'failed', current => { current.error = redact(String(error));
      for (const step of current.plan.steps) if (step.status === 'running') step.status = 'failed';
      for (const attempt of current.attempts) if (attempt.status === 'running') {
        attempt.status = controller.signal.aborted ? 'interrupted' : 'failed'; attempt.finishedAt = new Date().toISOString();
      }
    });
  } finally {
    clearTimeout(timer); clearInterval(heartbeat); input.signal?.removeEventListener('abort', abort);
    if (!leaseError) {
      try {
        if (!alreadyTerminal) update('task.checkpoint', { elapsedMs: Date.now() - started }, current => { current.elapsedMs = Date.now() - Date.parse(current.createdAt); });
        if (environment && task.environment!.resources.some(resource => resource.status !== 'removed')) await environment.cleanup();
        await exportEvidence(store, owner, task);
        task = store.get(task.id);
      } finally { store.release(task.id, owner); store.close(); }
    } else store.close();
  }
  return { report: task.report ?? JSON.parse(await readFile(join(task.directory, 'report.json'), 'utf8')), directory: task.directory };
}
function sha(data: string | Buffer): string { return createHash('sha256').update(data).digest('hex'); }
async function atomicWrite(path: string, data: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`; await writeFile(temporary, data); await rename(temporary, path);
}
async function exportEvidence(store: TaskStore, owner: string, task: TaskRecord): Promise<void> {
  let diff = ''; let diffError: string | undefined;
  if (task.prepared) try { diff = task.status === 'completed' ? await readFile(join(task.directory, 'changes.diff'), 'utf8') : await captureDiff(task.workspacePath); } catch (error) { diffError = String(error); }
  const last = task.attempts.at(-1);
  const tokens: Record<string, number> = {};
  for (const attempt of task.attempts) for (const [key, value] of Object.entries(attempt.result?.usage ?? {})) tokens[key] = (tokens[key] ?? 0) + value;
  const report: Report = {
    id: task.id, request: task.request, repositoryPath: task.repositoryPath, workspacePath: task.workspacePath,
    outcome: diffError ? 'failed' : task.status === 'completed' ? 'completed' : task.status === 'blocked' ? 'blocked' : task.status === 'cancelled' ? 'cancelled' : 'failed',
    implemented: { summary: task.error ?? last?.result?.summary ?? '', diff: join(task.directory, 'changes.diff'), hasChanges: diff.length > 0 },
    verification: task.verification, security: { status: 'unavailable', coverage: [] },
    environment: {
      dependencies: task.environment?.dependencies.length ? task.environment.dependencies.map(item => `${item.name}: ${item.kind}, health verified=${item.verified}`).join('; ') : 'No disposable services provisioned.',
      resources: [...(task.prepared ? [task.workspacePath] : []), ...(task.environment?.resources.map(item => `${item.kind}:${item.name}:${item.status}`) ?? [])],
      execution: task.environment?.config.mode ?? 'host', recoveries: task.environment?.recoveries, cleanupErrors: task.environment?.cleanupErrors,
    },
    limitations: ['Milestone 3: no security scanners or production/external integration verification.', task.environment?.config.mode === 'docker' ? 'Configured verification backend: resource-limited Docker. The Codex worker uses its SDK workspace sandbox; check results show what actually ran.' : 'Explicit host mode: verification commands run locally. No Docker isolation was used.', 'Acceptance criteria guide execution; automated completion gates are the configured build and test commands.', ...(task.environment?.limitations ?? []), ...(task.environment?.cleanupErrors.map(error => `Resource cleanup incomplete: ${error}`) ?? []), ...(diffError ? [`Diff capture failed: ${diffError}`] : [])],
    usage: { elapsedMs: task.elapsedMs, agentTurns: task.attempts.length, retries: task.maxRepairAttempts - task.remainingRepairAttempts, tokens }, sessionId: last?.sessionId,
    nextActions: task.status === 'completed' && !diffError ? [] : ['Inspect the event journal, retained workspace, sessions, and verification evidence. Ambiguous interrupted actions require manual reconciliation; start a new task only after inspecting their effects.'],
  };
  await mkdir(task.directory, { recursive: true });
  const files: Record<string, string> = {
    'changes.diff': diff, 'report.json': JSON.stringify(report, null, 2) + '\n', 'report.md': renderReport(report),
    'task.json': JSON.stringify({ ...task, report: undefined }, null, 2) + '\n',
  };
  // Persist the report before exports; interrupted exports are regenerated on resume.
  store.update(task.id, owner, 'task.finished', { outcome: report.outcome }, current => { current.report = report; });
  files['events.jsonl'] = store.events(task.id).map(event => JSON.stringify(event)).join('\n') + '\n';
  for (const [name, data] of Object.entries(files)) {
    const path = join(task.directory, name); await atomicWrite(path, data); store.artifact(task.id, owner, path, sha(data), name);
  }
}
function renderReport(report: Report): string {
  return `# Task ${report.id}\n\nOutcome: ${report.outcome}\n\n${report.implemented.summary}\n\nDiff: ${report.implemented.diff}\nWorkspace: ${report.workspacePath ?? 'unavailable'}\n\n## Verification\n\n${report.verification.map(check => `- ${check.name}: ${check.status}; command: ${JSON.stringify(check.command)}; ${check.durationMs}ms; evidence: ${check.artifact}`).join('\n') || 'No checks ran.'}\n\n## Security\n\nUnavailable; no scanners ran.\n\n## Environment\n\n${report.environment.dependencies}\n\nExecution: ${report.environment.execution ?? 'host'}\nResources: ${report.environment.resources.join(', ') || 'none'}\nRecoveries: ${JSON.stringify(report.environment.recoveries ?? [])}\nCleanup errors: ${JSON.stringify(report.environment.cleanupErrors ?? [])}\n\n## Limitations\n\n${report.limitations.map(item => `- ${item}`).join('\n')}\n\n## Usage\n\n${JSON.stringify(report.usage)}\n\n## Next actions\n\n${report.nextActions.join('\n') || 'None.'}\n`;
}
