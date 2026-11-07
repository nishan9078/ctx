import type { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CommandActor, TaskSnapshot } from '../../shared/src/domain.js';
import type { RegisteredProject } from '../../shared/src/repository.js';
import type { LeaseClaim } from '../../shared/src/scheduling.js';
import { validateVerificationProfile, verificationHash, type VerificationProfile, type FrozenVerificationProfile, type VerificationWaiver, type GateReport, gateReportStatus, gateStatuses } from '../../shared/src/verification-profile.js';
import { CtxError, ValidationError } from '../../shared/src/errors.js';
import { verifyTestSummary } from '../../shared/src/test-evidence.js';
import { identifier, integer, text } from '../../shared/src/validation.js';
import { readJsonFile } from './artifact-files.js';
import { workerGroupState } from './process-identity.js';
import type { ArtifactManifest } from '../../shared/src/artifacts.js';
import type { StoredWorkerProcess } from './queue-operations.js';
interface Context {
  db: DatabaseSync; dataDirectory: string; verifyArtifact(id: string): Promise<ArtifactManifest>; write<T>(work: () => T): T; read<T>(work: () => T): T;
  task(id: string): TaskSnapshot; project(id: string): RegisteredProject; assertLease(claim: LeaseClaim): void;
  actor(value: CommandActor): CommandActor; redactText(value: string): string;
  event(entity: string, id: string, type: string, actor: CommandActor, reason: string, payload: unknown, taskId?: string): void;
}
interface ProfileRow { hash: string; definition_json: string; owner_id: string }
interface WaiverRow { id: string; task_id: string; task_spec_hash: string; profile_hash: string; step_id: string; attempt_sequence: number; reason: string; approved_by: string; expires_at: string; created_at: string; used_by_attempt: string | null }
export class VerificationRegistry {
  constructor(private readonly context: Context) {}
  private owner(actor: CommandActor): CommandActor { const value = this.context.actor(actor); if (!['cli','local'].includes(value.source)) throw new CtxError('UNAUTHORIZED', 'Verification policy requires authenticated local owner authority'); return value; }
  register(projectId: string, input: unknown, context: CommandActor, reason: string): { profile: VerificationProfile; hash: string; ownerId: string } {
    const actor = this.owner(context); identifier(projectId, 'projectId'); this.context.project(projectId); text(reason, 'reason');
    const profile = validateVerificationProfile(input); const json = JSON.stringify(profile);
    if (Buffer.byteLength(json) > 1000000 || this.context.redactText(json) !== json) throw new ValidationError('profile', 'bounded policy must not contain credentials');
    const hash = verificationHash({ projectId, profile });
    return this.context.write(() => {
      const prior = this.get(projectId, profile.id);
      if (prior) { if (prior.hash !== hash || prior.ownerId !== actor.actorId) throw new CtxError('CONFLICT', 'Verification profiles are immutable; register a new profile ID'); return prior; }
      this.context.db.prepare('INSERT INTO ctx_verification_profiles VALUES(?,?,?,?,?,?)').run(projectId, profile.id, hash, json, actor.actorId, new Date().toISOString());
      this.context.event('profile', `${projectId}/${profile.id}`, 'verification.profile_registered', actor, reason, { hash, backend: profile.backend, checks: profile.steps.map(step => ({ id: step.id, required: step.required })) });
      return { profile, hash, ownerId: actor.actorId };
    });
  }
  get(projectId: string, profileId: string): { profile: VerificationProfile; hash: string; ownerId: string } | undefined {
    return this.context.read(() => { const row = this.context.db.prepare('SELECT * FROM ctx_verification_profiles WHERE project_id=? AND profile_id=?').get(projectId, profileId) as ProfileRow | undefined; return row ? { profile: JSON.parse(row.definition_json), hash: row.hash, ownerId: row.owner_id } : undefined; });
  }
  frozen(attemptId: string): FrozenVerificationProfile | undefined {
    return this.context.read(() => { const row = this.context.db.prepare('SELECT * FROM ctx_attempt_profiles WHERE attempt_id=?').get(attemptId) as { task_spec_hash: string; profile_hash: string | null; definition_json: string | null; owner_id: string | null } | undefined;
      return row ? { attemptId, taskSpecHash: row.task_spec_hash, ...(row.profile_hash ? { profileHash: row.profile_hash, profile: JSON.parse(row.definition_json!), ownerId: row.owner_id! } : {}) } : undefined;
    });
  }
  bind(claim: LeaseClaim, context: CommandActor): FrozenVerificationProfile {
    const actor = this.context.actor(context);
    return this.context.write(() => {
      this.context.assertLease(claim); const task = this.context.task(claim.task.spec.id); const specHash = verificationHash(task.spec);
      if (verificationHash(claim.task.spec) !== specHash) throw new CtxError('CONFLICT', 'Task packet differs from the authoritative specification');
      const prior = this.frozen(claim.attempt.id); if (prior) { if (prior.taskSpecHash !== specHash) throw new CtxError('CONFLICT', 'Attempt specification changed'); return prior; }
      const registered = this.get(task.spec.projectId, task.spec.verificationProfile);
      this.context.db.prepare('INSERT INTO ctx_attempt_profiles VALUES(?,?,?,?,?)').run(claim.attempt.id, specHash, registered?.hash ?? null, registered ? JSON.stringify(registered.profile) : null, registered?.ownerId ?? null);
      this.context.event('attempt', claim.attempt.id, registered ? 'verification.profile_bound' : 'verification.profile_unavailable', actor, registered ? 'Exact owner-defined gates frozen before execution' : 'No approved profile exists; completion cannot pass', { profileId: task.spec.verificationProfile, profileHash: registered?.hash ?? null, taskSpecHash: specHash }, task.spec.id);
      return this.frozen(claim.attempt.id)!;
    });
  }
  assertHistoricalQuiescence(claim: LeaseClaim, context: CommandActor): void {
    this.owner(context);
    const row = this.context.db.prepare('SELECT task_id,state FROM ctx_attempts WHERE id=?').get(claim.attempt.id) as { task_id: string; state: string } | undefined;
    if (!row || row.task_id !== claim.task.spec.id || ['leased','running','verifying'].includes(row.state) || this.context.db.prepare("SELECT 1 FROM ctx_attempts WHERE task_id=? AND state IN ('leased','running','verifying')").get(row.task_id)) throw new CtxError('CONFLICT', 'Historical reporting requires a stopped task without active work');
    const worker = this.context.db.prepare('SELECT pid,pgid,host,identity FROM ctx_worker_processes WHERE attempt_id=?').get(claim.attempt.id) as { pid: number; pgid: number; host: string; identity: string } | undefined;
    if (worker && workerGroupState(worker) !== 'dead') throw new CtxError('CONFLICT', 'Historical worker remains live or unobservable');
    this.assertProcessesStopped(claim.attempt.id);
  }
  bindHistoricalMissing(claim: LeaseClaim, context: CommandActor): FrozenVerificationProfile {
    const actor = this.owner(context);
    return this.context.write(() => {
      this.assertHistoricalQuiescence(claim, actor); const prior = this.frozen(claim.attempt.id); if (prior) return prior;
      const hash = verificationHash(this.context.task(claim.task.spec.id).spec);
      this.context.db.prepare('INSERT INTO ctx_attempt_profiles VALUES(?,?,NULL,NULL,NULL)').run(claim.attempt.id, hash);
      this.context.event('attempt', claim.attempt.id, 'verification.historical_requirements_unknown', actor, 'Historical gates cannot be invented or replayed', {}, claim.task.spec.id);
      return this.frozen(claim.attempt.id)!;
    });
  }
  grantWaiver(taskId: string, expectedRevision: number, stepId: string, reason: string, expiresAt: string, context: CommandActor): VerificationWaiver {
    const actor = this.owner(context); identifier(taskId, 'taskId'); identifier(stepId, 'stepId'); text(reason, 'waiver.reason'); integer(expectedRevision, 1, Number.MAX_SAFE_INTEGER, 'expectedRevision');
    const expiry = Date.parse(expiresAt); if (!Number.isFinite(expiry) || expiry <= Date.now() || expiry > Date.now() + 86400000) throw new ValidationError('waiver.expiresAt', 'waivers must expire within 24 hours');
    return this.context.write(() => {
      const task = this.context.task(taskId); if (task.revision !== expectedRevision || ['completed','cancelled'].includes(task.state)) throw new CtxError('CONFLICT', 'Waiver requires unchanged, unfinished task state');
      if (this.context.db.prepare("SELECT 1 FROM ctx_attempts WHERE task_id=? AND state IN ('leased','running','verifying')").get(taskId)) throw new CtxError('CONFLICT', 'Waivers are granted before a specific next attempt, not while work is running');
      const registered = this.get(task.spec.projectId, task.spec.verificationProfile);
      const step = registered?.profile.steps.find(item => item.id === stepId);
      if (!registered || registered.ownerId !== actor.actorId || !step?.waivable) throw new CtxError('UNAUTHORIZED', 'Only this profile owner may waive an explicitly waivable check');
      const sequence = (this.context.db.prepare('SELECT COALESCE(MAX(sequence),0)+1 AS n FROM ctx_attempts WHERE task_id=?').get(taskId) as { n: number }).n;
      const id = randomUUID(); const at = new Date().toISOString();
      this.context.db.prepare('INSERT INTO ctx_verification_waivers(id,task_id,task_spec_hash,profile_hash,step_id,attempt_sequence,reason,approved_by,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id, taskId, verificationHash(task.spec), registered.hash, stepId, sequence, reason, actor.actorId, new Date(expiry).toISOString(), at);
      this.context.event('waiver', id, 'verification.waiver_granted', actor, reason, { profileHash: registered.hash, stepId, attemptSequence: sequence, expiresAt }, taskId);
      return this.waivers(taskId).find(item => item.id === id)!;
    });
  }
  waivers(taskId: string): VerificationWaiver[] {
    return this.context.read(() => (this.context.db.prepare('SELECT * FROM ctx_verification_waivers WHERE task_id=? ORDER BY created_at,id').all(taskId) as unknown as WaiverRow[]).map(row => ({ id: row.id, taskId: row.task_id, taskSpecHash: row.task_spec_hash, profileHash: row.profile_hash, stepId: row.step_id, attemptSequence: row.attempt_sequence, reason: row.reason, approvedBy: row.approved_by, expiresAt: row.expires_at, createdAt: row.created_at, usedByAttempt: row.used_by_attempt ?? undefined })));
  }
  applicableWaiver(claim: LeaseClaim, stepId: string): VerificationWaiver | undefined {
    const frozen = this.frozen(claim.attempt.id); const step = frozen?.profile?.steps.find(item => item.id === stepId);
    if (!step?.waivable) return undefined;
    return this.waivers(claim.task.spec.id).find(waiver => waiver.stepId === stepId && waiver.attemptSequence === claim.attempt.sequence && waiver.taskSpecHash === frozen!.taskSpecHash && waiver.profileHash === frozen!.profileHash && waiver.approvedBy === frozen!.ownerId && Date.parse(waiver.expiresAt) > Date.now() && (!waiver.usedByAttempt || waiver.usedByAttempt === claim.attempt.id));
  }
  recordProcess(claim: LeaseClaim, stepId: string, input: StoredWorkerProcess): string {
    return this.context.write(() => {
      this.context.assertLease(claim); identifier(stepId, 'stepId'); integer(input.pid, 1, Number.MAX_SAFE_INTEGER, 'pid');
      if (input.pgid !== input.pid || input.identity === 'unknown') throw new CtxError('CONFLICT', 'Verification commands require an owned observable process group');
      const id = randomUUID(); this.context.db.prepare('INSERT INTO ctx_verification_processes VALUES(?,?,?,?,?,?,?,?,?)').run(id, claim.attempt.id, stepId, input.pid, input.pgid, input.host, input.identity, input.startedAt, null);
      return id;
    });
  }
  endProcess(claim: LeaseClaim, id: string): void { this.context.write(() => { this.context.assertLease(claim); this.context.db.prepare('UPDATE ctx_verification_processes SET ended_at=? WHERE id=? AND attempt_id=?').run(new Date().toISOString(), id, claim.attempt.id); }); }
  processes(attemptId: string): StoredWorkerProcess[] { return this.context.read(() => (this.context.db.prepare('SELECT pid,pgid,host,identity,started_at FROM ctx_verification_processes WHERE attempt_id=?').all(attemptId) as { pid: number; pgid: number; host: string; identity: string; started_at: string }[]).map(row => ({ pid: row.pid, pgid: row.pgid, host: row.host, identity: row.identity, startedAt: row.started_at }))); }
  assertProcessesStopped(attemptId: string): void {
    for (const process of this.processes(attemptId)) if (workerGroupState(process) !== 'dead') throw new CtxError('CONFLICT', 'Verification process group is still live or unobservable');
  }
  private validateReport(claim: LeaseClaim, report: GateReport): void {
    const frozen = this.frozen(claim.attempt.id);
    if (!frozen || report.schemaVersion !== 1 || report.attemptId !== claim.attempt.id || report.taskId !== claim.task.spec.id || report.taskSpecHash !== frozen.taskSpecHash || report.taskSpecHash !== verificationHash(this.context.task(report.taskId).spec) || report.profileId !== claim.task.spec.verificationProfile || report.profileHash !== frozen.profileHash || !Array.isArray(report.steps) || !Array.isArray(report.artifactIds) || report.artifactIds.length > 20000 || new Set(report.artifactIds).size !== report.artifactIds.length) throw new CtxError('CONFLICT', 'Verification report identity or immutable requirements do not match');
    identifier(report.id, 'report.id');
    if (!['completed','failed','interrupted'].includes(report.harnessOutcome)) throw new CtxError('CONFLICT', 'Invalid report harness outcome');
    for (const step of report.steps) {
      if (!gateStatuses.includes(step.status) || !gateStatuses.includes(step.observedStatus) || !Number.isFinite(step.durationMs) || step.durationMs < 0 || !Array.isArray(step.findings) || !step.environment || !report.artifactIds.includes(step.stdoutArtifactId) || !report.artifactIds.includes(step.stderrArtifactId)) throw new CtxError('CONFLICT', 'Verification step evidence is incomplete');
      const definition = frozen.profile?.steps.find(item => item.id === step.id);
      if (!definition || step.environment.timeoutMs !== definition.timeoutMs) throw new CtxError('CONFLICT', 'Verification step policy changed');
      if (step.status === 'passed' && definition.command && (step.environment.backend !== frozen.profile!.backend || frozen.profile!.backend === 'none')) throw new CtxError('CONFLICT', 'Command execution backend does not match owner-approved policy');
      if (step.status === 'passed' && step.kind === 'codex_security' && !definition.enabled) throw new CtxError('CONFLICT', 'Disabled security scanner cannot pass');
      if (step.status === 'passed' && (step.durationMs > definition.timeoutMs || !Number.isFinite(Date.parse(step.startedAt)) || !Number.isFinite(Date.parse(step.endedAt)) || Date.parse(step.endedAt) < Date.parse(step.startedAt))) throw new CtxError('CONFLICT', 'Passing step timing evidence is invalid');
      if (step.status === 'passed' && (step.observedStatus !== 'passed' || step.timedOut || step.exitCode !== 0 || step.environment.backend === 'mock' || definition.integration === 'mock' || step.findings.some(finding => finding.severity !== 'informational'))) throw new CtxError('CONFLICT', 'Unexecuted, mocked or failed check cannot be counted as passed');
      if (step.status === 'skipped_with_approval') {
        const waiver = this.applicableWaiver(claim, step.id);
        if (!waiver || step.waiverId !== waiver.id || step.observedStatus === 'passed') throw new CtxError('CONFLICT', 'Scoped owner waiver is missing, expired or inapplicable');
      } else if (step.waiverId || step.status !== step.observedStatus) throw new CtxError('CONFLICT', 'Observed verification result was rewritten');
    }
    if (report.status !== gateReportStatus(frozen.profile, report.steps, report.harnessOutcome)) throw new CtxError('CONFLICT', 'Verification summary contradicts its exact configured gates');
    this.assertProcessesStopped(claim.attempt.id);
  }
  private async auditTestEvidence(report: GateReport): Promise<void> {
    const profile = this.frozen(report.attemptId)?.profile;
    for (const step of report.steps.filter(step => step.status === 'passed')) {
      const policy = profile?.steps.find(item => item.id === step.id);
      if (!policy?.testReport) continue;
      const stdout = await this.context.verifyArtifact(step.stdoutArtifactId); const stderr = await this.context.verifyArtifact(step.stderrArtifactId);
      const { readFile } = await import('node:fs/promises');
      const output = await readFile(join(this.context.dataDirectory, stdout.location), 'utf8') + await readFile(join(this.context.dataDirectory, stderr.location), 'utf8');
      if (!verifyTestSummary(output, policy.testReport.format, policy.testReport.minimumTests).passed) throw new CtxError('CONFLICT', 'Passing test gate lacks the configured independent test evidence');
    }
  }
  async recordReport(claim: LeaseClaim, jsonArtifactId: string, markdownArtifactId: string, context: CommandActor): Promise<GateReport> {
    const actor = this.context.actor(context);
    const json = await this.context.verifyArtifact(jsonArtifactId); const markdown = await this.context.verifyArtifact(markdownArtifactId);
    if (json.kind !== 'verification-report-json' || markdown.kind !== 'verification-report-markdown') throw new CtxError('CONFLICT', 'Unexpected verification report artifact kind');
    const report = await readJsonFile(join(this.context.dataDirectory, json.location), 1000000) as GateReport;
    const historical = report.reconciled === true;
    if (historical) { this.assertHistoricalQuiescence(claim, actor); if (['passed','passed_with_waivers'].includes(report.status)) throw new CtxError('CONFLICT', 'Reconciliation reports can never establish completion'); }
    for (const item of [json, markdown]) if (item.taskId !== claim.task.spec.id || (historical ? item.attemptId !== undefined : item.attemptId !== claim.attempt.id)) throw new CtxError('CONFLICT', 'Verification report belongs to another attempt');
    this.validateReport(claim, report);
    await this.auditTestEvidence(report);
    for (const artifactId of report.artifactIds) { const artifact = await this.context.verifyArtifact(artifactId); if (artifact.taskId !== report.taskId || (artifact.attemptId !== report.attemptId && !(historical && artifact.attemptId === undefined))) throw new CtxError('CONFLICT', 'Verification evidence contains a foreign artifact'); }
    return this.context.write(() => {
      if (historical) this.assertHistoricalQuiescence(claim, actor); else this.context.assertLease(claim); this.validateReport(claim, report);
      this.context.db.prepare('INSERT INTO ctx_verification_runs(id,attempt_id,profile,status,started_at,ended_at,report_artifact_id,markdown_artifact_id,profile_hash,workspace_hash,metadata_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(report.id, report.attemptId, report.profileId, report.status, report.startedAt, report.endedAt, jsonArtifactId, markdownArtifactId, report.profileHash ?? null, report.workspaceHash ?? null, JSON.stringify({ report, reportHash: verificationHash(report) }));
      for (const step of report.steps) this.context.db.prepare('INSERT INTO ctx_verification_steps(run_id,name,required,status,command,exit_code,stdout_ref,stderr_ref,metadata_json) VALUES(?,?,?,?,?,?,?,?,?)').run(report.id, step.id, step.required ? 1 : 0, step.status, step.command ? JSON.stringify(step.command) : null, step.exitCode, step.stdoutArtifactId, step.stderrArtifactId, JSON.stringify(step));
      this.context.event('verification', report.id, 'verification.report_recorded', actor, 'Independent verification results and immutable evidence recorded', { status: report.status, reportArtifactId: jsonArtifactId, markdownArtifactId, profileHash: report.profileHash ?? null }, report.taskId);
      return report;
    });
  }
  reports(taskId: string): { id: string; attemptId: string; status: string; reportArtifactId?: string; markdownArtifactId?: string }[] {
    return this.context.read(() => (this.context.db.prepare('SELECT r.* FROM ctx_verification_runs r JOIN ctx_attempts a ON a.id=r.attempt_id WHERE a.task_id=? ORDER BY a.sequence,r.started_at,r.id').all(taskId) as { id: string; attempt_id: string; status: string; report_artifact_id: string | null; markdown_artifact_id: string | null }[]).map(row => ({ id: row.id, attemptId: row.attempt_id, status: row.status, reportArtifactId: row.report_artifact_id ?? undefined, markdownArtifactId: row.markdown_artifact_id ?? undefined })));
  }
  recorded(claim: LeaseClaim, runId: string): GateReport {
    const row = this.context.db.prepare('SELECT metadata_json,attempt_id FROM ctx_verification_runs WHERE id=?').get(runId) as { metadata_json: string; attempt_id: string } | undefined;
    if (!row || row.attempt_id !== claim.attempt.id) throw new CtxError('CONFLICT', 'No matching immutable verification report');
    const metadata = JSON.parse(row.metadata_json) as { report: GateReport; reportHash: string };
    if (!metadata.report || verificationHash(metadata.report) !== metadata.reportHash) throw new CtxError('CONFLICT', 'Verification report metadata changed');
    this.validateReport(claim, metadata.report); return metadata.report;
  }
  async auditRecorded(claim: LeaseClaim, runId: string): Promise<GateReport> {
    const report = this.context.read(() => this.recorded(claim, runId));
    await this.auditTestEvidence(report);
    const row = this.context.db.prepare('SELECT report_artifact_id,markdown_artifact_id FROM ctx_verification_runs WHERE id=?').get(runId) as { report_artifact_id: string; markdown_artifact_id: string };
    for (const id of [...report.artifactIds, row.report_artifact_id, row.markdown_artifact_id]) { const artifact = await this.context.verifyArtifact(id); if (artifact.taskId !== report.taskId || artifact.attemptId !== report.attemptId) throw new CtxError('CONFLICT', 'Verification evidence is not attempt-owned'); }
    const json = await this.context.verifyArtifact(row.report_artifact_id); const artifactReport = await readJsonFile(join(this.context.dataDirectory, json.location), 1000000);
    if (verificationHash(artifactReport) !== verificationHash(report)) throw new CtxError('CONFLICT', 'Recorded report differs from immutable artifact');
    if (['passed','passed_with_waivers'].includes(report.status)) {
      if (!report.harnessArtifactId || !report.artifactIds.includes(report.harnessArtifactId)) throw new CtxError('CONFLICT', 'No independent harness completion evidence');
      const proof = await this.context.verifyArtifact(report.harnessArtifactId);
      const harness = await readJsonFile(join(this.context.dataDirectory, proof.location), 1000000) as { taskId: string; attemptId: string; taskSpecHash: string; outcome: string; exitCode: number; harnessId: string };
      if (proof.kind !== 'harness-result' || harness.taskId !== report.taskId || harness.attemptId !== report.attemptId || harness.taskSpecHash !== report.taskSpecHash || harness.outcome !== 'completed' || harness.exitCode !== 0 || harness.harnessId !== claim.attempt.harnessId) throw new CtxError('CONFLICT', 'Harness evidence does not establish a completed turn');
      const workspace = this.context.db.prepare('SELECT task_id,state,archive_tree_hash,archive_artifact_id FROM ctx_workspaces WHERE id=?').get(report.workspaceId ?? '') as { task_id: string; state: string; archive_tree_hash: string; archive_artifact_id: string } | undefined;
      if (!workspace || workspace.task_id !== report.taskId || workspace.state !== 'archived' || workspace.archive_tree_hash !== report.workspaceHash || !report.resultSha) throw new CtxError('CONFLICT', 'Passed verification requires the matching archived deliverable');
      const archive = await this.context.verifyArtifact(workspace.archive_artifact_id);
      const receipt = await readJsonFile(join(this.context.dataDirectory, archive.location), 1000000) as { headSha: string; treeHash: string };
      if (receipt.headSha !== report.resultSha || receipt.treeHash !== report.workspaceHash || !report.artifactIds.includes(archive.id)) throw new CtxError('CONFLICT', 'Verified commit or workspace archive does not match report');
    }
    return report;
  }
  consumeWaivers(claim: LeaseClaim, runId: string, context: CommandActor): GateReport {
    if (!this.context.db.isTransaction) throw new CtxError('INTERNAL', 'Verification finalization must be transactional');
    const report = this.recorded(claim, runId); const actor = this.context.actor(context);
    if (['passed','passed_with_waivers'].includes(report.status)) for (const step of report.steps.filter(step => step.waiverId)) {
      this.context.db.prepare('UPDATE ctx_verification_waivers SET used_by_attempt=? WHERE id=? AND (used_by_attempt IS NULL OR used_by_attempt=?)').run(claim.attempt.id, step.waiverId!, claim.attempt.id);
      this.context.event('waiver', step.waiverId!, 'verification.waiver_consumed', actor, 'Exact one-attempt owner waiver applied', { runId, stepId: step.id }, claim.task.spec.id);
    }
    return report;
  }

}
