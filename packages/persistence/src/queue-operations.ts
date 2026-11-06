import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Attempt, CommandActor, Notification, TaskSnapshot, TaskState } from '../../shared/src/domain.js';
import type { ClaimInput, FixtureVerification, LeaseClaim, QueueConfiguration, QueueStatus, WorkerOutcome } from '../../shared/src/scheduling.js';
import { fixtureAcceptance } from '../../shared/src/scheduling.js';
import type { RegisteredProject } from '../../shared/src/repository.js';
import type { ArtifactManifest } from '../../shared/src/artifacts.js';
import { CtxError } from '../../shared/src/errors.js';
import { identifier, integer, record, text } from '../../shared/src/validation.js';
import { assertTaskTransition, isTerminalState } from '../../shared/src/transitions.js';
import { readJsonFile, sha256 } from './artifact-files.js';
import { ownerState, processIdentity, workerGroupState } from './process-identity.js';
export interface QueueContext {
  db: DatabaseSync; dataDirectory: string; write<T>(work: () => T): T;
  read<T>(work: () => T): T;
  task(id: string): TaskSnapshot; project(id: string): RegisteredProject;
  actor(value: CommandActor): CommandActor; safeText(value: unknown, path: string): string;
  event(entity: string, id: string, type: string, actor: CommandActor, reason: string, payload: unknown, taskId?: string): void;
  verifyArtifact(id: string): Promise<ArtifactManifest>;
  redactText(value: string): string;
}
interface LeaseRow { task_id: string; attempt_id: string; owner_id: string; fencing_token: number; expires_at: string; owner_pid: number; owner_host: string; owner_start: string }
export interface StoredWorkerEvent { attemptId: string; sequence: number; kind: 'canonical' | 'diagnostic'; type: string; payload: unknown; deliveryId: string; createdAt: string }
export interface StoredSession { externalSessionId: string | null; externalRunId: string | null; version: string }
export interface StoredWorkerProcess { pid: number; pgid: number; host: string; identity: string; startedAt: string }
const now = (): string => new Date().toISOString();
const deadline = (delay: number): string => new Date(Date.now() + integer(delay, 0, 86400000, 'delayMs')).toISOString();
const activeStates = ['leased', 'running', 'verifying'];
export class QueueOperations {
  readonly #c: QueueContext;
  constructor(context: QueueContext) { this.#c = context; }
  configuration(): QueueConfiguration {
    const row = this.#c.db.prepare("SELECT validated_value FROM ctx_settings WHERE key='queue.configuration'").get() as { validated_value: string } | undefined;
    if (!row) return { maxWorkers: 1, maxWorkersPerProject: 1, paused: false };
    const value = record(JSON.parse(row.validated_value) as unknown, 'queue.configuration');
    const maxWorkers = integer(value.maxWorkers, 1, 2, 'maxWorkers'); const perProject = integer(value.maxWorkersPerProject, 1, maxWorkers, 'maxWorkersPerProject');
    if (typeof value.paused !== 'boolean') throw new CtxError('CONFLICT', 'Stored queue pause setting is invalid');
    return { maxWorkers, maxWorkersPerProject: perProject, paused: value.paused };
  }
  configure(input: { maxWorkers: number; maxWorkersPerProject: number }, context: CommandActor): QueueConfiguration {
    const actor = this.#c.actor(context); const maxWorkers = integer(input.maxWorkers, 1, 2, 'maxWorkers'); const maxWorkersPerProject = integer(input.maxWorkersPerProject, 1, maxWorkers, 'maxWorkersPerProject');
    return this.#c.write(() => { const config = { ...this.configuration(), maxWorkers, maxWorkersPerProject }; this.saveConfiguration(config); this.#c.event('scheduler', 'global', 'queue.configured', actor, 'Owner configured concurrency', config); return config; });
  }
  private saveConfiguration(config: QueueConfiguration): void { this.#c.db.prepare("INSERT INTO ctx_settings VALUES('queue.configuration',?,?) ON CONFLICT(key) DO UPDATE SET validated_value=excluded.validated_value,updated_at=excluded.updated_at").run(JSON.stringify(config), now()); }
  pauseAll(paused: boolean, context: CommandActor): void {
    if (typeof paused !== 'boolean') throw new CtxError('INVALID_INPUT', 'Pause must be boolean'); const actor = this.#c.actor(context);
    this.#c.write(() => { this.saveConfiguration({ ...this.configuration(), paused }); this.#c.event('scheduler', 'global', paused ? 'queue.paused' : 'queue.resumed', actor, 'Global pause uses drain policy; running attempts may finish', {}); });
  }
  private notify(task: TaskSnapshot, message: string): void {
    const kind: Notification['kind'] | undefined = ({ completed: 'completed', failed: 'blocked', blocked: 'blocked', waiting_capacity: 'capacity_wait', waiting_approval: 'approval_requested', cancelled: 'progress' } as Partial<Record<TaskState, Notification['kind']>>)[task.state];
    if (!kind) return;
    const original = this.#c.db.prepare("SELECT destination FROM ctx_outbox WHERE task_id=? AND kind='accepted' ORDER BY created_at LIMIT 1").get(task.spec.id) as { destination: string } | undefined;
    if (!original) throw new CtxError('CONFLICT', 'Task has no acknowledgement delivery route');
    const at = now(); const notice: Notification = { id: randomUUID(), taskId: task.spec.id, destination: JSON.parse(original.destination), kind, deduplicationKey: `${task.spec.id}:${task.revision}:${task.state}`, message: this.#c.safeText(message, 'notification.message'), createdAt: at, nextAttemptAt: at, retryCount: 0 };
    this.#c.db.prepare('INSERT INTO ctx_outbox(id,task_id,destination,kind,deduplication_key,payload,next_attempt_at,created_at) VALUES(?,?,?,?,?,?,?,?)').run(notice.id, notice.taskId, original.destination, kind, notice.deduplicationKey, JSON.stringify(notice), at, at);
  }
  private move(id: string, to: TaskState, actor: CommandActor, reason: string, nextRunAt: string | null = null): TaskSnapshot {
    const task = this.#c.task(id); assertTaskTransition(task.state, to); const why = this.#c.safeText(reason, 'reason');
    this.#c.db.prepare('UPDATE ctx_tasks SET state=?,revision=revision+1,reason=?,next_run_at=?,updated_at=? WHERE id=?').run(to, why, nextRunAt, now(), id);
    const updated = this.#c.task(id); this.#c.event('task', id, `task.${to}`, actor, why, { from: task.state, to, revision: updated.revision }, id); this.notify(updated, `${id}: ${to}. ${why}`); return updated;
  }
  private control(id: string): 'pause' | 'cancel' | null { return (this.#c.db.prepare('SELECT control_intent FROM ctx_tasks WHERE id=?').get(id) as { control_intent: 'pause' | 'cancel' | null }).control_intent; }
  private epoch(id: string): number { return (this.#c.db.prepare('SELECT retry_epoch FROM ctx_tasks WHERE id=?').get(id) as { retry_epoch: number }).retry_epoch; }
  private count(id: string): number { return (this.#c.db.prepare('SELECT COUNT(*) AS n FROM ctx_attempts WHERE task_id=? AND retry_epoch=?').get(id, this.epoch(id)) as { n: number }).n; }
  private pendingApproval(id: string): boolean { return !!this.#c.db.prepare("SELECT id FROM ctx_approvals WHERE task_id=? AND decision='pending' LIMIT 1").get(id); }
  private active(id: string): boolean { return !!this.#c.db.prepare("SELECT id FROM ctx_attempts WHERE task_id=? AND state IN ('leased','running','verifying') LIMIT 1").get(id) || !!this.#c.db.prepare('SELECT task_id FROM ctx_leases WHERE task_id=?').get(id); }
  refresh(context: CommandActor): void {
    const actor = this.#c.actor(context);
    this.#c.write(() => {
      const expired = this.#c.db.prepare("SELECT id,task_id FROM ctx_approvals WHERE decision='pending' AND expires_at<=?").all(now()) as { id: string; task_id: string }[];
      for (const approval of expired) { this.#c.db.prepare("UPDATE ctx_approvals SET decision='expired',decided_at=?,decided_by=? WHERE id=?").run(now(), actor.actorId, approval.id); this.#c.event('approval', approval.id, 'approval.expired', actor, 'Approval deadline expired without authorization', {}, approval.task_id); if (this.#c.task(approval.task_id).state === 'waiting_approval') this.move(approval.task_id, 'blocked', actor, 'Approval expired; owner input required'); }
      const rows = this.#c.db.prepare("SELECT id FROM ctx_tasks WHERE state IN ('queued','waiting_dependency','ready','recovering','waiting_capacity') ORDER BY id LIMIT 10001").all() as { id: string }[];
      if (rows.length > 10000) throw new CtxError('BUDGET_EXHAUSTED', 'Queue refresh exceeds its task budget');
      // Reach a fixed point so failed dependencies propagate regardless of task ID order.
      for (let pass = 0; pass <= rows.length; pass++) {
        let changes = 0;
        for (const { id } of rows) {
          let task = this.#c.task(id); if (isTerminalState(task.state) || task.state === 'blocked' || this.active(id)) continue;
          if (task.nextRunAt && task.nextRunAt > now()) continue;
          if (task.state === 'recovering') { task = this.move(id, 'queued', actor, 'Retry deadline reached; re-evaluate eligibility'); changes++; }
          if (this.pendingApproval(id)) { this.move(id, 'blocked', actor, 'Outstanding approval prevents execution'); changes++; continue; }
          const deps = this.#c.db.prepare('SELECT t.id,t.state FROM ctx_task_dependencies d JOIN ctx_tasks t ON t.id=d.prerequisite_id WHERE d.task_id=?').all(id) as { id: string; state: TaskState }[];
          const failed = deps.find(dep => ['failed', 'cancelled', 'blocked'].includes(dep.state));
          if (failed) { this.move(id, 'blocked', actor, `Prerequisite ${failed.id} is ${failed.state}; owner retry/revision required`); changes++; continue; }
          if (deps.some(dep => dep.state !== 'completed')) { if (task.state === 'waiting_capacity') task = this.move(id, 'ready', actor, 'Capacity deadline reached'); if (task.state !== 'waiting_dependency') { this.move(id, 'waiting_dependency', actor, 'Hard prerequisites are unfinished'); changes++; } continue; }
          if (task.spec.mode !== 'delegated') { this.move(id, 'blocked', actor, 'Interactive tasks require owner control'); changes++; continue; }
          if (this.count(id) >= task.spec.maxAttempts) { this.move(id, 'blocked', actor, 'Attempt budget exhausted; explicit owner retry required'); changes++; continue; }
          const project = this.#c.project(task.spec.projectId);
          try { if (realpathSync(project.repositoryPath) !== project.repositoryPath || !statSync(project.repositoryPath).isDirectory()) throw new Error(); }
          catch { this.move(id, 'blocked', actor, 'Registered repository is missing or changed identity'); changes++; continue; }
          if (project.policyId === 'fixture-only' && (project.verificationProfile !== 'fixture-v1' || JSON.stringify(task.spec.acceptance) !== JSON.stringify([fixtureAcceptance]))) { this.move(id, 'blocked', actor, 'Fixture tasks require the exact independently checkable fixture acceptance profile'); changes++; continue; }
          if (task.state !== 'ready') { this.move(id, 'ready', actor, 'Dependencies, registration and deadline permit execution'); changes++; }
        }
        if (!changes) break;
      }
    });
  }
  claim(input: ClaimInput, context: CommandActor): LeaseClaim | undefined {
    const actor = this.#c.actor(context); const ownerId = identifier(input.ownerId, 'ownerId'); integer(input.leaseMs, 100, 60000, 'leaseMs');
    if (this.#c.safeText(ownerId, 'ownerId') !== ownerId) throw new CtxError('INVALID_INPUT', 'Owner identity must not contain credentials');
    if (!['fixture', 'codex', 'opencode'].includes(input.workerKind)) throw new CtxError('INVALID_INPUT', 'Unknown worker kind');
    return this.#c.write(() => {
      const config = this.configuration(); if (config.paused) return;
      const active = (this.#c.db.prepare("SELECT COUNT(*) AS n FROM ctx_attempts WHERE state IN ('leased','running','verifying')").get() as { n: number }).n;
      if (active >= config.maxWorkers) return;
      const candidates = this.#c.db.prepare(`SELECT t.id FROM ctx_tasks t JOIN ctx_projects p ON p.id=t.project_id WHERE t.state='ready' AND (t.next_run_at IS NULL OR t.next_run_at<=?)
        AND ((?='fixture' AND p.policy_id='fixture-only' AND p.test_profile='fixture-v1') OR (?<>'fixture' AND p.policy_id<>'fixture-only' AND (json_extract(t.spec_json,'$.preferredHarness') IN ('auto',?))))
        ORDER BY CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,t.created_at,t.id`).all(now(), input.workerKind, input.workerKind, input.workerKind) as { id: string }[];
      for (const { id } of candidates) {
        const task = this.#c.task(id); if (this.active(id) || this.pendingApproval(id) || this.count(id) >= task.spec.maxAttempts) continue;
        const project = this.#c.project(task.spec.projectId);
        if (task.spec.mode !== 'delegated' || input.workerKind === 'fixture' && JSON.stringify(task.spec.acceptance) !== JSON.stringify([fixtureAcceptance])) { this.move(id, 'blocked', actor, 'Worker capability or acceptance contract does not authorize this task'); continue; }
        try { if (realpathSync(project.repositoryPath) !== project.repositoryPath || !statSync(project.repositoryPath).isDirectory()) throw new Error(); }
        catch { this.move(id, 'blocked', actor, 'Registered repository changed before atomic claim'); continue; }
        if (this.#c.db.prepare("SELECT 1 FROM ctx_task_dependencies d JOIN ctx_tasks t ON t.id=d.prerequisite_id WHERE d.task_id=? AND t.state<>'completed' LIMIT 1").get(id)) continue;
        const used = (this.#c.db.prepare("SELECT COUNT(*) AS n FROM ctx_attempts a JOIN ctx_tasks t ON t.id=a.task_id WHERE t.project_id=? AND a.state IN ('leased','running','verifying')").get(task.spec.projectId) as { n: number }).n;
        if (used >= config.maxWorkersPerProject) continue;
        const sequence = (this.#c.db.prepare('SELECT COALESCE(MAX(sequence),0)+1 AS n FROM ctx_attempts WHERE task_id=?').get(id) as { n: number }).n;
        const claimed = this.move(id, 'leased', actor, 'Atomically claimed an exclusive worker slot'); const at = now();
        const attempt: Attempt = { id: randomUUID(), taskId: id, sequence, taskRevision: claimed.revision, state: 'leased', harnessId: input.workerKind, providerKey: input.workerKind === 'fixture' ? 'fixture/local' : `${input.workerKind}/unprobed`, modelId: input.workerKind === 'fixture' ? 'deterministic-fixture' : 'unprobed', fencingToken: sequence, startedAt: at };
        this.#c.db.prepare('INSERT INTO ctx_attempts(id,task_id,sequence,task_revision,state,harness_id,provider_key,model_id,fencing_token,started_at,retry_epoch) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(attempt.id, id, sequence, attempt.taskRevision, 'leased', attempt.harnessId, attempt.providerKey, attempt.modelId, sequence, at, this.epoch(id));
        const expiresAt = deadline(input.leaseMs);
        this.#c.db.prepare('INSERT INTO ctx_leases VALUES(?,?,?,?,?,?,?,?,?)').run(id, attempt.id, ownerId, sequence, expiresAt, at, process.pid, hostname(), processIdentity());
        this.#c.event('attempt', attempt.id, 'attempt.claimed', actor, 'Lease and attempt committed together', { sequence, fencingToken: sequence, workerKind: input.workerKind, ownerId }, id);
        return { task: claimed, attempt, ownerId, fencingToken: sequence, expiresAt };
      }
    });
  }
  private fence(claim: LeaseClaim, allowExpired = false): LeaseRow {
    const lease = this.#c.db.prepare('SELECT * FROM ctx_leases WHERE task_id=?').get(claim.task.spec.id) as unknown as LeaseRow | undefined;
    if (!lease || lease.attempt_id !== claim.attempt.id || lease.fencing_token !== claim.fencingToken || lease.owner_id !== claim.ownerId || lease.owner_pid !== process.pid || lease.owner_host !== hostname() || lease.owner_start !== processIdentity() || !allowExpired && lease.expires_at <= now()) throw new CtxError('CONFLICT', 'Lease expired or worker was fenced; stale writes are refused');
    return lease;
  }
  assertArtifactOwner(taskId: string, attemptId: string): void {
    const row = this.#c.db.prepare('SELECT * FROM ctx_leases WHERE task_id=? AND attempt_id=?').get(taskId, attemptId) as unknown as LeaseRow | undefined;
    if (!row || row.owner_pid !== process.pid || row.owner_host !== hostname() || row.owner_start !== processIdentity() || row.expires_at <= now()) throw new CtxError('CONFLICT', 'Artifact writer has no current attempt lease');
  }
  heartbeat(claim: LeaseClaim, leaseMs: number): 'pause' | 'cancel' | null {
    integer(leaseMs, 100, 60000, 'leaseMs');
    return this.#c.write(() => { this.fence(claim); this.#c.db.prepare('UPDATE ctx_leases SET expires_at=?,last_heartbeat=? WHERE task_id=?').run(deadline(leaseMs), now(), claim.task.spec.id); return this.control(claim.task.spec.id); });
  }
  start(claim: LeaseClaim, context: CommandActor): void {
    const actor = this.#c.actor(context); this.#c.write(() => { this.fence(claim); if (this.control(claim.task.spec.id) === 'cancel') throw new CtxError('CANCELLED', 'Cancellation requested before worker start'); if (this.configuration().paused) throw new CtxError('CONFLICT', 'Global pause prevents an unstarted claim from invoking a worker'); this.move(claim.task.spec.id, 'running', actor, 'Worker starts only after committed running state'); this.#c.db.prepare("UPDATE ctx_attempts SET state='running' WHERE id=? AND state='leased'").run(claim.attempt.id); });
  }
  beginVerification(claim: LeaseClaim, context: CommandActor): void {
    const actor = this.#c.actor(context); this.#c.write(() => { this.fence(claim); if (this.control(claim.task.spec.id) === 'cancel') throw new CtxError('CANCELLED', 'Cancellation requested'); this.move(claim.task.spec.id, 'verifying', actor, 'Worker returned; independent verification starts'); this.#c.db.prepare("UPDATE ctx_attempts SET state='verifying' WHERE id=?").run(claim.attempt.id); });
  }
  private end(claim: LeaseClaim, state: Attempt['state']): void { this.#c.db.prepare('UPDATE ctx_attempts SET state=?,ended_at=? WHERE id=?').run(state, now(), claim.attempt.id); this.#c.db.prepare('DELETE FROM ctx_leases WHERE task_id=? AND attempt_id=? AND fencing_token=?').run(claim.task.spec.id, claim.attempt.id, claim.fencingToken); this.#c.db.prepare('UPDATE ctx_tasks SET control_intent=NULL WHERE id=?').run(claim.task.spec.id); }
  settle(claim: LeaseClaim, outcome: Exclude<WorkerOutcome, { kind: 'success' }>, context: CommandActor): void {
    const actor = this.#c.actor(context); const reason = this.#c.safeText(outcome.reason, 'reason');
    this.#c.write(() => {
      this.fence(claim); const id = claim.task.spec.id; const intent = this.control(id);
      if (intent === 'cancel') { this.end(claim, 'cancelled'); this.move(id, 'cancelled', actor, 'Worker stopped after cancellation'); return; }
      if (outcome.kind === 'blocked') {
        // Uncertain side effects (transport loss after possible edits, missing auth,
        // codex turn without required verification) must block for reconciliation.
        this.end(claim, 'interrupted'); this.move(id, 'blocked', actor, reason); return;
      }
      if (outcome.kind === 'approval') {
        this.end(claim, 'interrupted'); const task = this.move(id, 'waiting_approval', actor, reason); const approvalId = randomUUID();
        this.#c.db.prepare('INSERT INTO ctx_approvals(id,task_id,task_revision,attempt_id,action,action_hash,requested_by,expires_at,decision) VALUES(?,?,?,?,?,?,?,?,?)').run(approvalId, id, task.revision, claim.attempt.id, 'external_write', sha256(JSON.stringify([id, claim.attempt.id, task.spec.objective])), actor.actorId, deadline(3600000), 'pending');
        this.#c.event('approval', approvalId, 'approval.requested', actor, reason, { attemptId: claim.attempt.id }, id); return;
      }
      const delay = outcome.kind === 'capacity' ? outcome.delayMs : outcome.delayMs ?? 1000;
      const retryable = outcome.kind === 'capacity' || outcome.retryable;
      this.end(claim, outcome.kind === 'capacity' ? 'interrupted' : 'failed');
      if (!retryable || this.count(id) >= this.#c.task(id).spec.maxAttempts) this.move(id, 'failed', actor, `${reason}; retry budget exhausted or failure is fatal`);
      else if (intent === 'pause') this.move(id, 'paused', actor, 'Attempt drained; owner pause prevents retry', deadline(delay));
      else this.move(id, outcome.kind === 'capacity' ? 'waiting_capacity' : 'recovering', actor, reason, deadline(delay));
    });
  }
  /** Caller must have awaited worker quiescence; a timeout alone never proves a stopped worker. */
  stopped(claim: LeaseClaim, context: CommandActor, reason: string): void {
    const actor = this.#c.actor(context);
    this.#c.write(() => { this.fence(claim, true); const id = claim.task.spec.id; const intent = this.control(id); this.end(claim, intent === 'cancel' ? 'cancelled' : 'interrupted'); this.move(id, intent === 'cancel' ? 'cancelled' : intent === 'pause' ? 'paused' : claim.attempt.harnessId === 'fixture' ? 'recovering' : 'blocked', actor, reason, intent ? null : now()); });
  }
  async completeFixture(claim: LeaseClaim, evidence: FixtureVerification, context: CommandActor): Promise<void> {
    const actor = this.#c.actor(context); if (claim.attempt.harnessId !== 'fixture') throw new CtxError('CONFLICT', 'Real harness completion requires the P06 verification pipeline');
    const result = await this.#c.verifyArtifact(evidence.resultArtifactId); const report = await this.#c.verifyArtifact(evidence.reportArtifactId);
    if (result.taskId !== claim.task.spec.id || report.taskId !== result.taskId || result.attemptId !== claim.attempt.id || report.attemptId !== claim.attempt.id || result.kind !== 'fixture-result' || report.kind !== 'fixture-report') throw new CtxError('CONFLICT', 'Fixture verification evidence does not belong to this attempt');
    const receipt = record(await readJsonFile(join(this.#c.dataDirectory, result.location), 1000000), 'fixture.result');
    const checked = record(await readJsonFile(join(this.#c.dataDirectory, report.location), 1000000), 'fixture.report');
    if (receipt.taskId !== claim.task.spec.id || receipt.specHash !== sha256(JSON.stringify(claim.task.spec)) || checked.taskId !== claim.task.spec.id || checked.attemptId !== claim.attempt.id || checked.fixtureOnly !== true || checked.status !== 'passed' || checked.resultSha256 !== result.sha256) throw new CtxError('CONFLICT', 'Independent fixture verification did not pass');
    this.#c.write(() => {
      this.fence(claim); const id = claim.task.spec.id; const task = this.#c.task(id); const project = this.#c.project(task.spec.projectId);
      if (project.policyId !== 'fixture-only' || project.verificationProfile !== 'fixture-v1' || JSON.stringify(task.spec.acceptance) !== JSON.stringify([fixtureAcceptance])) throw new CtxError('CONFLICT', 'Fixture completion is restricted to its explicit project and acceptance contract');
      if (this.control(id) === 'cancel') { this.end(claim, 'cancelled'); this.move(id, 'cancelled', actor, 'Cancellation won before finalization'); return; }
      const run = randomUUID(); const at = now(); this.#c.db.prepare('INSERT INTO ctx_verification_runs(id,attempt_id,profile,status,started_at,ended_at) VALUES(?,?,?,?,?,?)').run(run, claim.attempt.id, 'fixture-v1', 'passed', at, at);
      for (const [name, artifact] of [['fixture-output', result.id], ['fixture-report', report.id]]) this.#c.db.prepare('INSERT INTO ctx_verification_steps(run_id,name,required,status,command,exit_code,stdout_ref,stderr_ref) VALUES(?,?,?,?,?,?,?,?)').run(run, name, 1, 'passed', 'deterministic fixture verifier (no live harness)', 0, artifact);
      this.end(claim, 'completed'); this.move(id, 'completed', actor, 'Fixture-only task: independent output/profile checks and immutable evidence passed');
    });
  }
  controlTask(id: string, operation: 'pause' | 'cancel' | 'resume' | 'retry', expectedRevision: number, context: CommandActor, reason: string): TaskSnapshot {
    if (!['pause', 'cancel', 'resume', 'retry'].includes(operation)) throw new CtxError('INVALID_INPUT', 'Unknown queue control operation');
    identifier(id, 'taskId'); integer(expectedRevision, 1, Number.MAX_SAFE_INTEGER, 'expectedRevision'); const actor = this.#c.actor(context); const why = this.#c.safeText(reason, 'reason');
    return this.#c.write(() => {
      const task = this.#c.task(id); if (task.revision !== expectedRevision) throw new CtxError('CONFLICT', 'Task revision changed; reload before control');
      if (operation === 'resume') { if (task.state !== 'paused' || this.active(id)) throw new CtxError('CONFLICT', 'Only a quiescent paused task can resume'); return this.move(id, 'queued', actor, why, task.nextRunAt ?? null); }
      if (operation === 'retry') {
        if (!['blocked', 'failed', 'cancelled'].includes(task.state) || this.active(id) || this.pendingApproval(id)) throw new CtxError('CONFLICT', 'Retry requires a quiescent terminal/blocked task without pending approval');
        this.#c.db.prepare("UPDATE ctx_tasks SET state='queued',revision=revision+1,retry_epoch=retry_epoch+1,control_intent=NULL,next_run_at=NULL,reason=?,updated_at=? WHERE id=?").run(why, now(), id);
        this.#c.event('task', id, 'task.retry_requested', actor, why, { from: task.state, to: 'queued', revision: task.revision + 1, explicitNewRevision: true }, id); return this.#c.task(id);
      }
      if (isTerminalState(task.state)) throw new CtxError('CONFLICT', 'Terminal task cannot be paused/cancelled');
      if (this.active(id)) {
        if (this.control(id) === 'cancel' && operation === 'pause') throw new CtxError('CONFLICT', 'Cancellation cannot be undone by pause');
        this.#c.db.prepare('UPDATE ctx_tasks SET control_intent=?,revision=revision+1,reason=?,updated_at=? WHERE id=?').run(operation, why, now(), id);
        this.#c.event('task', id, `task.${operation}_requested`, actor, why, { activeAttemptMustStopBeforeRelease: operation === 'cancel', drain: operation === 'pause' }, id); return this.#c.task(id);
      }
      if (operation === 'cancel') {
        const pending = this.#c.db.prepare("SELECT id FROM ctx_approvals WHERE task_id=? AND decision='pending'").all(id) as { id: string }[];
        for (const approval of pending) { this.#c.db.prepare("UPDATE ctx_approvals SET decision='expired',decided_by=?,decided_at=? WHERE id=?").run(actor.actorId, now(), approval.id); this.#c.event('approval', approval.id, 'approval.invalidated', actor, 'Task cancelled', {}, id); }
      }
      return this.move(id, operation === 'cancel' ? 'cancelled' : 'paused', actor, why, operation === 'pause' ? task.nextRunAt ?? null : null);
    });
  }
  reconcile(context: CommandActor): { recovered: number; alive: number; unknown: number } {
    const actor = this.#c.actor(context);
    return this.#c.write(() => {
      const counts = { recovered: 0, alive: 0, unknown: 0 }; const leases = this.#c.db.prepare('SELECT * FROM ctx_leases WHERE expires_at<=?').all(now()) as unknown as LeaseRow[];
      for (const lease of leases) {
        const state = ownerState(lease.owner_pid, lease.owner_host, lease.owner_start); if (state !== 'dead') { counts[state]++; continue; }
        const worker = this.workerProcess(lease.attempt_id);
        if (worker) { const workerState = workerGroupState(worker); if (workerState !== 'dead') { counts[workerState]++; continue; } }
        const attempt = this.#c.db.prepare('SELECT harness_id FROM ctx_attempts WHERE id=?').get(lease.attempt_id) as { harness_id: string }; const intent = this.control(lease.task_id);
        this.#c.db.prepare("UPDATE ctx_attempts SET state='interrupted',ended_at=? WHERE id=?").run(now(), lease.attempt_id); this.#c.db.prepare('DELETE FROM ctx_leases WHERE task_id=? AND fencing_token=?').run(lease.task_id, lease.fencing_token); this.#c.db.prepare('UPDATE ctx_tasks SET control_intent=NULL WHERE id=?').run(lease.task_id);
        this.move(lease.task_id, intent === 'cancel' ? 'cancelled' : intent === 'pause' ? 'paused' : attempt.harness_id === 'fixture' ? 'recovering' : 'blocked', actor, attempt.harness_id === 'fixture' ? 'Expired fixture owner confirmed dead; idempotent retry is safe' : 'Owner confirmed dead; real worker effects require explicit reconciliation', now());
        this.#c.event('attempt', lease.attempt_id, 'attempt.reconciled', actor, 'Lease owner identity confirmed exited', { fencingToken: lease.fencing_token }, lease.task_id); counts.recovered++;
      }
      return counts;
    });
  }
  attempts(taskId: string): Attempt[] {
    identifier(taskId, 'taskId'); const rows = this.#c.db.prepare('SELECT * FROM ctx_attempts WHERE task_id=? ORDER BY sequence').all(taskId) as { id: string; sequence: number; task_revision: number; state: Attempt['state']; harness_id: Attempt['harnessId']; provider_key: string; model_id: string; fencing_token: number; started_at: string; ended_at: string | null }[];
    return rows.map(row => ({ id: row.id, taskId, sequence: row.sequence, taskRevision: row.task_revision, state: row.state, harnessId: row.harness_id, providerKey: row.provider_key, modelId: row.model_id, fencingToken: row.fencing_token, startedAt: row.started_at, ...(row.ended_at ? { endedAt: row.ended_at } : {}) }));
  }
  /** Feature C (P04-04): fenced worker event / diagnostics / session / process records. */
  private boundedPayload(payload: unknown): string {
    const bound = (value: unknown, depth: number, stringCap: number): unknown => {
      if (typeof value === 'string') return this.#c.redactText(value.length > stringCap ? `${value.slice(0, stringCap)}[TRUNCATED]` : value);
      if (Array.isArray(value)) return depth > 8 ? '[OMITTED]' : value.slice(0, 100).map(item => bound(item, depth + 1, stringCap));
      if (typeof value === 'object' && value !== null) return depth > 8 ? '[OMITTED]' : Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, item]) => [key, bound(item, depth + 1, stringCap)]));
      return value;
    };
    let cap = 4096;
    let serialized = JSON.stringify(bound(payload, 0, cap));
    while (serialized.length > 8192 && cap > 0) { cap = Math.floor(cap / 2); serialized = JSON.stringify(bound(payload, 0, cap)); }
    if (serialized.length > 8192) throw new CtxError('BUDGET_EXHAUSTED', 'Worker event payload exceeds the durable event budget');
    return serialized;
  }
  appendWorkerEvent(claim: LeaseClaim, input: { kind: 'canonical' | 'diagnostic'; type: string; payload: unknown; deliveryId: string }): { sequence: number } {
    const type = this.#c.safeText(input.type, 'workerEvent.type');
    const deliveryId = this.#c.safeText(input.deliveryId, 'workerEvent.deliveryId');
    if (input.kind === 'canonical') {
      const event = record(input.payload, 'workerEvent');
      if (event.taskId !== claim.task.spec.id || event.attemptId !== claim.attempt.id || event.type !== type) throw new CtxError('CONFLICT', 'Canonical event identity does not match its claim');
    }
    const serialize = (sequence: number) => this.boundedPayload(input.kind === 'canonical' ? { ...record(input.payload, 'workerEvent'), sequence } : input.payload);
    return this.#c.write(() => {
      this.fence(claim);
      const existing = this.#c.db.prepare('SELECT sequence,kind,type,payload FROM ctx_worker_events WHERE attempt_id=? AND delivery_id=?').get(claim.attempt.id, deliveryId) as { sequence: number; kind: string; type: string; payload: string } | undefined;
      if (existing) {
        if (existing.kind === input.kind && existing.type === type && existing.payload === serialize(existing.sequence)) return { sequence: existing.sequence };
        throw new CtxError('CONFLICT', 'Duplicate worker event delivery conflicts with the recorded content');
      }
      const next = (this.#c.db.prepare('SELECT COALESCE(MAX(sequence),0)+1 AS n FROM ctx_worker_events WHERE attempt_id=?').get(claim.attempt.id) as { n: number }).n;
      this.#c.db.prepare('INSERT INTO ctx_worker_events(attempt_id,sequence,kind,type,payload,delivery_id,created_at) VALUES(?,?,?,?,?,?,?)').run(claim.attempt.id, next, input.kind, type, serialize(next), deliveryId, now());
      return { sequence: next };
    });
  }
  recordHarnessMetadata(claim: LeaseClaim, input: { modelId: string }, context: CommandActor): void {
    const actor = this.#c.actor(context); const model = this.#c.safeText(input.modelId, 'modelId');
    this.#c.write(() => {
      this.fence(claim);
      this.#c.db.prepare('UPDATE ctx_attempts SET provider_key=?,model_id=? WHERE id=?').run(`${claim.attempt.harnessId}/unknown`, model, claim.attempt.id);
      this.#c.event('attempt', claim.attempt.id, 'attempt.harness_metadata', actor, 'Configured model recorded; provider/account identity remains unknown', { modelId: model }, claim.task.spec.id);
    });
  }
  recordSession(claim: LeaseClaim, session: { externalSessionId: string; externalRunId?: string; version: string }): void {
    const external = this.#c.safeText(session.externalSessionId, 'session.externalSessionId');
    const version = this.#c.safeText(session.version, 'session.version');
    const runId = session.externalRunId !== undefined ? this.#c.safeText(session.externalRunId, 'session.externalRunId') : null;
    this.#c.write(() => {
      this.fence(claim);
      if (!['codex', 'opencode'].includes(claim.attempt.harnessId)) throw new CtxError('CONFLICT', 'Session records only apply to real harness attempts');
      const prior = this.session(claim.attempt.id);
      if (prior && (prior.externalSessionId !== external || prior.version !== version || prior.externalRunId !== runId)) throw new CtxError('CONFLICT', 'Recorded harness session cannot be replaced');
      this.#c.db.prepare('INSERT INTO ctx_harness_sessions(attempt_id,adapter_id,external_session_id,external_run_id,version) VALUES(?,?,?,?,?) ON CONFLICT(attempt_id) DO UPDATE SET external_session_id=excluded.external_session_id,external_run_id=excluded.external_run_id,version=excluded.version').run(claim.attempt.id, claim.attempt.harnessId, external, runId, version);
    });
  }
  session(attemptId: string): StoredSession | undefined {
    identifier(attemptId, 'attemptId');
    return this.#c.read(() => {
      const row = this.#c.db.prepare('SELECT external_session_id,external_run_id,version FROM ctx_harness_sessions WHERE attempt_id=?').get(attemptId) as { external_session_id: string | null; external_run_id: string | null; version: string } | undefined;
      return row ? { externalSessionId: row.external_session_id, externalRunId: row.external_run_id, version: row.version } : undefined;
    });
  }
  recordWorkerProcess(claim: LeaseClaim, record: { pid: number; pgid: number; host: string; identity: string; startedAt: string }): void {
    const host = this.#c.safeText(record.host, 'workerProcess.host');
    const identity = this.#c.safeText(record.identity, 'workerProcess.identity');
    this.#c.write(() => {
      this.fence(claim);
      integer(record.pid, 1, Number.MAX_SAFE_INTEGER, 'workerProcess.pid');
      if (record.pgid !== record.pid || claim.attempt.harnessId === 'fixture') throw new CtxError('CONFLICT', 'Worker must own a dedicated real-harness process group');
      const prior = this.workerProcess(claim.attempt.id);
      if (prior && JSON.stringify(prior) !== JSON.stringify({ pid: record.pid, pgid: record.pgid, host, identity, startedAt: record.startedAt })) throw new CtxError('CONFLICT', 'Recorded worker process cannot be replaced');
      this.#c.db.prepare('INSERT INTO ctx_worker_processes(attempt_id,pid,pgid,host,identity,started_at) VALUES(?,?,?,?,?,?) ON CONFLICT(attempt_id) DO UPDATE SET pid=excluded.pid,pgid=excluded.pgid,host=excluded.host,identity=excluded.identity,started_at=excluded.started_at').run(claim.attempt.id, record.pid, record.pgid, host, identity, record.startedAt);
    });
  }
  workerProcess(attemptId: string): StoredWorkerProcess | undefined {
    identifier(attemptId, 'attemptId');
    return this.#c.read(() => {
      const row = this.#c.db.prepare('SELECT pid,pgid,host,identity,started_at FROM ctx_worker_processes WHERE attempt_id=?').get(attemptId) as { pid: number; pgid: number; host: string; identity: string; started_at: string } | undefined;
      return row ? { pid: row.pid, pgid: row.pgid, host: row.host, identity: row.identity, startedAt: row.started_at } : undefined;
    });
  }
  /**
   * Neutral finalization for Codex-turn success without P06 verification.
   * Releases the lease, preserves evidence, and blocks the task for the
   * engineering verification pipeline. Never marks the task completed.
   */
  blockVerificationHandoff(claim: LeaseClaim, context: CommandActor, input: { reason: string; artifactIds?: string[] }): void {
    const actor = this.#c.actor(context); const reason = this.#c.safeText(input.reason, 'handoff.reason');
    this.#c.write(() => {
      this.fence(claim); const id = claim.task.spec.id; const task = this.#c.task(id);
      if (task.state !== 'verifying') throw new CtxError('CONFLICT', 'Verification handoff requires the verifying state');
      if (this.control(id) === 'cancel') { this.end(claim, 'cancelled'); this.move(id, 'cancelled', actor, 'Cancellation won before verification handoff'); return; }
      const at = now(); const run = randomUUID();
      this.#c.db.prepare('INSERT INTO ctx_verification_runs(id,attempt_id,profile,status,started_at,ended_at) VALUES(?,?,?,?,?,?)').run(run, claim.attempt.id, task.spec.verificationProfile, 'not_run', at, at);
      this.#c.db.prepare('INSERT INTO ctx_verification_steps(run_id,name,required,status,command,exit_code,stdout_ref,stderr_ref) VALUES(?,?,?,?,?,?,?,?)').run(run, 'engineering-verification', 1, 'unavailable', 'P06 engineering verification pipeline is not available in this phase; required evidence is preserved for explicit verification', null, null, null);
      this.end(claim, 'completed');
      const artifactNote = input.artifactIds && input.artifactIds.length ? ` Evidence artifacts: ${input.artifactIds.join(', ')}.` : ' Evidence artifacts are preserved with the attempt.';
      this.move(id, 'blocked', actor, `${reason}.${artifactNote} Task is blocked awaiting independent verification and must not be treated as completed.`);
    });
  }

  workerEvents(attemptId: string, kind?: 'canonical' | 'diagnostic'): StoredWorkerEvent[] {
    identifier(attemptId, 'attemptId');
    const rows = this.#c.read(() => (this.#c.db.prepare('SELECT attempt_id,sequence,kind,type,payload,delivery_id,created_at FROM ctx_worker_events WHERE attempt_id=? AND (? IS NULL OR kind=?) ORDER BY sequence').all(attemptId, kind ?? null, kind ?? null) as { attempt_id: string; sequence: number; kind: 'canonical' | 'diagnostic'; type: string; payload: string; delivery_id: string; created_at: string }[])
      .map(row => ({ attemptId: row.attempt_id, sequence: row.sequence, kind: row.kind, type: row.type, payload: JSON.parse(row.payload) as unknown, deliveryId: row.delivery_id, createdAt: row.created_at })));
    return rows;
  }

  status(): QueueStatus {
    return this.#c.read(() => this.snapshotStatus());
  }
  private snapshotStatus(): QueueStatus {
    const rows = this.#c.db.prepare('SELECT state,COUNT(*) AS n FROM ctx_tasks GROUP BY state').all() as { state: TaskState; n: number }[]; const counts = new Map(rows.map(row => [row.state, row.n]));
    const next = this.#c.db.prepare("SELECT MIN(next_run_at) AS at FROM ctx_tasks WHERE state IN ('queued','recovering','waiting_capacity') AND next_run_at IS NOT NULL").get() as { at: string | null };
    return { configuration: this.configuration(), total: rows.reduce((sum, row) => sum + row.n, 0), running: activeStates.reduce((sum, state) => sum + (counts.get(state as TaskState) ?? 0), 0), ready: counts.get('ready') ?? 0, waiting: ['queued','waiting_dependency','waiting_capacity','waiting_approval','recovering'].reduce((sum, state) => sum + (counts.get(state as TaskState) ?? 0), 0), blocked: counts.get('blocked') ?? 0, completed: counts.get('completed') ?? 0, failed: counts.get('failed') ?? 0, cancelled: counts.get('cancelled') ?? 0, paused: counts.get('paused') ?? 0, ...(next.at ? { nextRunAt: next.at } : {}) };
  }
}
