import { join } from 'node:path';
import type { GateReport } from '../../shared/src/verification-profile.js';
import type { TaskRepository } from '../../persistence/src/task-repository.js';
import { readJsonFile } from '../../persistence/src/artifact-files.js';
import { CtxError } from '../../shared/src/errors.js';
export async function verificationTaskDetails(repository: TaskRepository, taskId: string) {
  const task = repository.getTask(taskId); const attempts = repository.queue.attempts(taskId); const history = repository.verification.reports(taskId);
  const latest = history.filter(row => row.reportArtifactId).at(-1); let latestReport: GateReport | undefined;
  if (latest?.reportArtifactId) {
    const descriptor = await repository.verifyStoredArtifact(latest.reportArtifactId);
    latestReport = await readJsonFile(join(repository.dataDirectory, descriptor.location), 1000000) as GateReport;
    if (latestReport.taskId !== taskId || latestReport.attemptId !== latest.attemptId || latestReport.id !== latest.id || latestReport.status !== latest.status) throw new CtxError('CONFLICT', 'Task report identity does not match immutable verification history');
    const binding = repository.verification.frozen(latest.attemptId);
    if (binding?.profileHash !== latestReport.profileHash) throw new CtxError('CONFLICT', 'Report profile does not match the frozen attempt');
    for (const id of [...latestReport.artifactIds, latest.markdownArtifactId!]) {
      const artifact = await repository.verifyStoredArtifact(id);
      if (artifact.taskId !== taskId || (artifact.attemptId !== latest.attemptId && !(latestReport.reconciled && artifact.attemptId === undefined))) throw new CtxError('CONFLICT', 'Report evidence belongs to a different attempt');
    }
  }
  return { task, attempts, verification: history, latestReport, reportArtifactId: latest?.reportArtifactId, markdownArtifactId: latest?.markdownArtifactId, artifacts: repository.artifacts(taskId), warnings: latest ? [] : ['No structured engineering report is recorded; no verification pass is inferred.'] };
}
