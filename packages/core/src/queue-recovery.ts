import { join } from 'node:path';
import type { TaskRepository } from '../../persistence/src/task-repository.js';
import type { CommandActor } from '../../shared/src/domain.js';
import { recoveryDecision, retryDelay, type RecoveryPolicy } from '../../shared/src/recovery-policy.js';
import { readJsonFile } from '../../persistence/src/artifact-files.js';
import { readRecoveryCheckpoint } from './recovery-checkpoint.js';
export async function reconcileRecovery(repo: TaskRepository, actor: CommandActor, policy: RecoveryPolicy): Promise<void> {
  for (const task of repo.listTasks().filter(task=>task.state==='failed')) {
    const attempts = repo.queue.attempts(task.spec.id); const latest = attempts.at(-1)!;
    try {
      const checkpoint = await readRecoveryCheckpoint(repo,task.spec.id,latest.id,policy);
      if (!checkpoint) { repo.queue.scheduleRecovery(task.spec.id,latest.id,0,'No trustworthy checkpoint; owner reconciliation required',actor,true); continue; }
      let identical = 0; let sameClass = 0; let tokens = 0; let cost = 0; let accounted = true; let priced = true;
      for (const attempt of attempts) {
        const saved = repo.artifacts(task.spec.id).find(a=>a.attemptId===attempt.id && a.kind==='recovery-checkpoint');
        if (saved) { await repo.verifyStoredArtifact(saved.id); const previous = await readJsonFile(join(repo.dataDirectory,saved.location),1000000) as { fingerprint:string; kind:string }; identical += Number(previous.fingerprint===checkpoint.fingerprint); sameClass += Number(previous.kind===checkpoint.kind); }
        const result = repo.artifacts(task.spec.id).find(a=>a.attemptId===attempt.id && a.kind==='codex-result');
        if (!result) { accounted=false; priced=false; continue; }
        await repo.verifyStoredArtifact(result.id); const data = await readJsonFile(join(repo.dataDirectory,result.location),1000000) as {usage?:{inputTokens?:number;outputTokens?:number;costUsd?:number}};
        const usage = data.usage;
        if (!usage || !Number.isFinite(usage.inputTokens) || !Number.isFinite(usage.outputTokens)) accounted=false; else tokens+=usage.inputTokens!+usage.outputTokens!;
        if (!Number.isFinite(usage?.costUsd)) priced=false; else cost+=usage!.costUsd!;
      }
      const reason = recoveryDecision(policy,{kind:checkpoint.kind,repairs:attempts.length-1,sameClass:sameClass-1,identical,elapsedMs:Date.now()-Date.parse(attempts[0].startedAt),tokens:accounted?tokens:undefined,costUsd:priced?cost:undefined});
      repo.queue.scheduleRecovery(task.spec.id,latest.id,retryDelay(policy,attempts.length),reason ?? `Bounded repair from checkpoint ${latest.id}; identical failures ${identical}`,actor,!!reason);
    } catch { repo.queue.scheduleRecovery(task.spec.id,latest.id,0,'Checkpoint/evidence reconciliation failed; retained work requires owner inspection',actor,true); }
  }
}
