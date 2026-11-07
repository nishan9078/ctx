import { changedTreePaths } from '../../verification/src/profile-checks.js';
import { join } from 'node:path';
import type { CommandActor, PortableCheckpoint } from '../../shared/src/domain.js';
import type { LeaseClaim } from '../../shared/src/scheduling.js';
import { validateCheckpoint } from '../../shared/src/validation.js';
import { verificationHash, type GateReport } from '../../shared/src/verification-profile.js';
import { failureFingerprint, type RecoveryPolicy } from '../../shared/src/recovery-policy.js';
import { ArtifactStore } from '../../persistence/src/artifact-store.js';
import { readJsonFile } from '../../persistence/src/artifact-files.js';
import type { TaskRepository } from '../../persistence/src/task-repository.js';
import { workspaceTree } from '../../environment/src/workspace-tree.js';
import { OwnedWorkspaces } from './owned-workspaces.js';
import { CtxError } from '../../shared/src/errors.js';
export interface RecoveryCheckpoint { schemaVersion: 1; checkpoint: PortableCheckpoint; specHash: string; profileHash: string; policyHash: string; workspaceId: string; treeHash: string; fingerprint: string; failurePacket: string; kind: 'verification' | 'security'; reportId: string }
export async function writeRecoveryCheckpoint(repo: TaskRepository, claim: LeaseClaim, report: GateReport, policy: RecoveryPolicy, actor: CommandActor): Promise<void> {
  if (report.status !== 'failed' || !report.workspaceId || !report.profileHash || !report.workspaceHash) return;
  const workspace = await new OwnedWorkspaces(repo).assertOwned(report.workspaceId);
  const failures = report.steps.filter(step => step.required && step.status !== 'passed').map(step => ({ id: step.id, kind: step.kind, status: step.status, exitCode: step.exitCode, findings: step.findings.map(f => ({ scanner:f.scanner, path:f.path, message:f.message })) }));
  const kind = failures.some(step => ['scope','test_integrity','secrets','codex_security','dependencies'].includes(step.kind)) ? 'security' : 'verification';
  const reportRef = repo.verification.reports(report.taskId).find(row => row.id === report.id)!;
  const artifact = await repo.verifyStoredArtifact(reportRef.reportArtifactId!);
  const session = repo.queue.session(claim.attempt.id)?.externalSessionId;
  const checkpoint: PortableCheckpoint = validateCheckpoint({ schemaVersion:1, taskId:report.taskId, attemptId:report.attemptId, projectId:claim.task.spec.projectId, baseCommit:workspace.identity.baseSha, branch:workspace.identity.branch, worktree:workspace.identity.worktree, objective:claim.task.spec.objective, completedSteps:report.steps.filter(s=>s.status==='passed').map(s=>s.id), pendingSteps:failures.map(s=>s.id), decisions:['Resume retained edits; preserve frozen gates and existing tests'], changedFiles:changedTreePaths((await workspaceTree(workspace.identity.snapshot)).entries,(await workspaceTree(workspace.identity.worktree)).entries), knownBlockers:failures.map(s=>`${s.id}: ${s.status}`), lastVerification:{status:'failed',reason:'Independent verification failed'}, sessionRefs:session ? {codex:session} : {}, artifactHashes:{report:artifact.sha256} });
  const data: RecoveryCheckpoint = { schemaVersion:1, checkpoint, specHash:report.taskSpecHash, profileHash:report.profileHash, policyHash:verificationHash(policy), workspaceId:workspace.id, treeHash:report.workspaceHash, fingerprint:failureFingerprint(kind, failures), kind, reportId:report.id, failurePacket:JSON.stringify(failures).slice(0,12000) };
  const store = await ArtifactStore.open(repo.dataDirectory); await store.writeText({taskId:report.taskId,attemptId:report.attemptId,kind:'recovery-checkpoint'},JSON.stringify(data),repo,actor);
}
export async function readRecoveryCheckpoint(repo: TaskRepository, taskId: string, attemptId: string, policy: RecoveryPolicy): Promise<RecoveryCheckpoint | undefined> {
  const artifact = repo.artifacts(taskId).find(a=>a.attemptId===attemptId && a.kind==='recovery-checkpoint'); if (!artifact) return;
  await repo.verifyStoredArtifact(artifact.id); const data = await readJsonFile(join(repo.dataDirectory,artifact.location),1000000) as RecoveryCheckpoint;
  validateCheckpoint(data.checkpoint);
  const frozen = repo.verification.frozen(attemptId);
  if (data.schemaVersion!==1 || data.checkpoint.taskId!==taskId || data.checkpoint.attemptId!==attemptId || data.specHash!==verificationHash(repo.getTask(taskId).spec) || data.profileHash!==frozen?.profileHash || data.policyHash!==verificationHash(policy)) throw new CtxError('CONFLICT','Recovery checkpoint requirements changed');
  const report = repo.verification.reports(taskId).find(r=>r.id===data.reportId && r.attemptId===attemptId);
  if (!report?.reportArtifactId || (await repo.verifyStoredArtifact(report.reportArtifactId)).sha256!==data.checkpoint.artifactHashes.report) throw new CtxError('CONFLICT','Recovery report evidence changed');
  const reportArtifact = await repo.verifyStoredArtifact(report.reportArtifactId);
  const evidence = await readJsonFile(join(repo.dataDirectory, reportArtifact.location),1000000) as GateReport;
  for (const id of evidence.artifactIds) await repo.verifyStoredArtifact(id);
  const workspace = await new OwnedWorkspaces(repo).assertOwned(data.workspaceId);
  repo.verification.assertProcessesStopped(attemptId);
  if (workspace.taskId!==taskId || workspace.identity.worktree!==data.checkpoint.worktree || workspace.identity.baseSha!==data.checkpoint.baseCommit || workspace.identity.branch!==data.checkpoint.branch || (await workspaceTree(workspace.identity.worktree)).hash!==data.treeHash) throw new CtxError('CONFLICT','Retained workspace differs from checkpoint; owner reconciliation required');
  return data;
}
