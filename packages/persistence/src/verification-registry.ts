import type { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CommandActor, TaskSnapshot } from '../../shared/src/domain.js';
import type { RegisteredProject } from '../../shared/src/repository.js';
import type { LeaseClaim } from '../../shared/src/scheduling.js';
import { validateVerificationProfile, verificationHash, type VerificationProfile, type FrozenVerificationProfile, type VerificationWaiver, type GateReport, gateReportStatus, gateStatuses } from '../../shared/src/verification-profile.js';
import { CtxError, ValidationError } from '../../shared/src/errors.js';
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
}
