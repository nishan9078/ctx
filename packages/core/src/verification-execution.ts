import { mkdir } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import type { LeaseClaim } from '../../shared/src/scheduling.js';
import type { GateStep } from '../../shared/src/verification-profile.js';
import type { ProcessResult } from '../../environment/src/process-manager.js';
import { runOwnedCommand } from '../../environment/src/owned-command.js';
import { syntaxEnvironment } from '../../verification/src/checks.js';
import { RuntimeSampler, enforceRuntimeBudget } from '../../environment/src/runtime-health.js';
import { workerRuntimeBudget, type WorkerRuntimeBudget } from '../../shared/src/runtime.js';
import { processIdentity } from '../../persistence/src/process-identity.js';
import type { TaskRepository } from '../../persistence/src/task-repository.js';
import { CtxError } from '../../shared/src/errors.js';
export interface VerificationBackend {
  readonly kind: 'host' | 'docker' | 'mock';
  run(command: string[], workspace: string, signal: AbortSignal, timeoutMs: number): Promise<ProcessResult>;
}
export function verificationEnvironment(home: string): NodeJS.ProcessEnv {
  return { ...syntaxEnvironment(), HOME: home, npm_config_userconfig: '/dev/null', npm_config_globalconfig: '/dev/null', npm_config_update_notifier: 'false', PYTHONNOUSERSITE: '1' };
}
/** All controller-launched verification tools retain group identity and quiesce before result publication. */
export function trackedVerificationExecutor(repository: TaskRepository, claim: LeaseClaim, step: GateStep, workspace: string, resourceRoot: string, home: string, budgetInput?: Partial<WorkerRuntimeBudget>) {
  let ordinal = 0;
  return async (program: string, args: string[], cwd: string, options: { signal?: AbortSignal; timeoutMs?: number; env?: NodeJS.ProcessEnv; onOutput?: (text: string) => void } = {}): Promise<ProcessResult> => {
    await mkdir(home, { recursive: true, mode: 0o700 });
    const controller = new AbortController(); const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    const budget = workerRuntimeBudget(budgetInput); const sampler = new RuntimeSampler();
    let processId: string | undefined; let pgid: number | undefined; let resourceError: unknown; let sample: Promise<void> | undefined;
    const health = async () => {
      if (!pgid) return;
      const data = await sampler.sample(workspace, resourceRoot, pgid);
      repository.queue.appendWorkerEvent(claim, { kind: 'diagnostic', type: 'verification.health', payload: { stepId: step.id, ...data }, deliveryId: `verification-${step.id}-${processId}-${++ordinal}` });
      enforceRuntimeBudget(data, budget);
    };
    const timer = setInterval(() => { if (!sample && pgid) sample = health().catch(error => { resourceError ??= error; controller.abort(error); }).finally(() => { sample = undefined; }); }, budget.sampleMs);
    try {
      const result = await runOwnedCommand(program, args, cwd, { signal, timeoutMs: Math.min(step.timeoutMs, options.timeoutMs ?? step.timeoutMs), env: options.env ?? verificationEnvironment(home), onOutput: options.onOutput,
        onProcess(pid) { pgid = pid; processId = repository.verification.recordProcess(claim, step.id, { pid, pgid: pid, host: hostname(), identity: processIdentity(pid), startedAt: new Date().toISOString() }); },
      });
      clearInterval(timer); await sample; await health();
      if (resourceError) throw resourceError;
      return result;
    } finally {
      clearInterval(timer); await sample;
      if (processId) repository.verification.endProcess(claim, processId);
    }
  };
}
export async function runProfileCommand(repository: TaskRepository, claim: LeaseClaim, step: GateStep, workspace: string, resourceRoot: string, home: string, signal: AbortSignal, backend?: VerificationBackend, budget?: Partial<WorkerRuntimeBudget>): Promise<{ result: ProcessResult; backend: 'host' | 'docker' | 'mock' | 'none' }> {
  const frozen = repository.verification.frozen(claim.attempt.id)!; const selected = frozen.profile!.backend;
  const command = [step.command!.program, ...step.command!.args];
  if (backend) {
    if (backend.kind !== 'mock' && backend.kind !== selected) throw new CtxError('ENVIRONMENT_UNAVAILABLE', 'Configured verification backend does not match the frozen profile');
    return { result: await backend.run(command, workspace, signal, step.timeoutMs), backend: backend.kind };
  }
  if (selected !== 'host') throw new CtxError('ENVIRONMENT_UNAVAILABLE', selected === 'docker' ? 'No approved Docker verification backend was supplied; no host fallback was attempted' : 'Profile did not authorize project command execution');
  const execute = trackedVerificationExecutor(repository, claim, step, workspace, resourceRoot, home, budget);
  return { result: await execute(step.command!.program === 'node' ? process.execPath : step.command!.program, step.command!.args, workspace, { signal }), backend: 'host' };
}
