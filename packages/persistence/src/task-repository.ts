import type { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { openOrchestrationDatabase } from './migrations.js';
import type { CommandActor, Notification, TaskSnapshot, TaskState } from '../../shared/src/domain.js';
import { taskStates } from '../../shared/src/domain.js';
import type { AuditEvent, ProjectRegistration, RegisteredProject, SubmissionResult, TaskSubmission } from '../../shared/src/repository.js';
import { CtxError, ValidationError } from '../../shared/src/errors.js';
import { choice, identifier, integer, keys, list, parseTaskSpec, record, serializeTaskSpec, text, validateTaskSpec } from '../../shared/src/validation.js';
import { assertTaskTransition } from '../../shared/src/transitions.js';
import { redactForDiagnostics } from '../../shared/src/redact.js';
import { artifactPolicy, type ArtifactRecord } from '../../shared/src/artifacts.js';
import { ordinaryDirectory, recordedManifestHash, sha256, validateArtifact, verifyArtifact } from './artifact-files.js';
import { WorkspaceRegistry } from './workspace-registry.js';
import { QueueOperations } from './queue-operations.js';

interface TaskRow { id: string; project_id: string; spec_json: string; state: string; priority: string; revision: number; reason: string | null; next_run_at: string | null; created_at: string; updated_at: string }
interface ProjectRow { id: string; canonical_path: string; policy_id: string; test_profile: string; created_at: string }
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
const revision = (value: unknown): number => integer(value, 1, Number.MAX_SAFE_INTEGER - 1, 'expectedRevision');

/** Storage boundary for trusted local services. Remote callers require authorized ingress (P08/P09). */
export class TaskRepository {
  readonly #db: DatabaseSync;
  readonly #env: NodeJS.ProcessEnv;
  readonly queue: QueueOperations;
  readonly workspaces: WorkspaceRegistry;
  private constructor(db: DatabaseSync, env: NodeJS.ProcessEnv, readonly dataDirectory: string, readonly migrationBackupPath?: string) {
    this.#db = db; this.#env = env;
    this.queue = new QueueOperations({ db, dataDirectory, write: work => this.write(work), read: work => this.read(work), task: id => this.task(id), project: id => this.getProject(id), actor: value => this.actor(value), safeText: (value, path) => this.safeText(value, path), event: (...args) => this.event(...args), verifyArtifact: id => this.verifyStoredArtifact(id), redactText: value => redactForDiagnostics(value, this.#env) as string });
    this.workspaces = new WorkspaceRegistry({ db, dataDirectory, write: work => this.write(work), read: work => this.read(work), assertLease: claim => this.queue.assertLease(claim), task: id => this.task(id), event: (id, type, actor, payload, taskId) => this.event('workspace', id, type, this.actor(actor), type, payload, taskId) });
  }
  static async open(filename: string, env: NodeJS.ProcessEnv = process.env): Promise<TaskRepository> {
    const opened = await openOrchestrationDatabase(filename);
    return new TaskRepository(opened.db, { ...env }, dirname(resolve(filename)), opened.backupPath);
  }
  close(): void { this.#db.close(); }
  private safeText(value: unknown, path: string, max = 10_000): string {
    return redactForDiagnostics(text(value, path, max), this.#env) as string;
  }
  private label(value: unknown, path: string): string {
    const result = text(value, path, 200);
    if (/[\x00-\x1f\x7f]/.test(result) || this.safeText(result, path, 200) !== result) throw new ValidationError(path, 'expected an opaque label without credentials or control characters');
    return result;
  }
  private actor(input: CommandActor): CommandActor {
    const value = record(input, 'actor'); keys(value, ['actorId', 'source', 'requestId'], 'actor');
    return { actorId: this.label(value.actorId, 'actor.actorId'), source: choice(value.source, ['cli', 'discord', 'local'], 'actor.source'), requestId: this.label(value.requestId, 'actor.requestId') };
  }
  private write<T>(work: () => T): T {
    let begun = false;
    try { this.#db.exec('BEGIN IMMEDIATE'); begun = true; const result = work(); this.#db.exec('COMMIT'); return result; }
    catch (error) {
      if (begun) { try { this.#db.exec('ROLLBACK'); } catch { /* Preserve the original failure. */ } }
      if (error instanceof CtxError) throw error;
      const native = error as { code?: string; errcode?: number };
      const busy = native.code === 'SQLITE_BUSY' || native.errcode !== undefined && [5, 6].includes(native.errcode & 0xff);
      throw new CtxError(busy ? 'CONFLICT' : 'INTERNAL', 'Storage transaction failed; changes rolled back', busy);
    }
  }
  private read<T>(work: () => T): T {
    if (this.#db.isTransaction) return work();
    this.#db.exec('BEGIN');
    try { const result = work(); this.#db.exec('COMMIT'); return result; }
    catch (error) { this.#db.exec('ROLLBACK'); throw error; }
  }
  private event(entity: string, id: string, type: string, actor: CommandActor, reason: string, payload: unknown, taskId?: string): void {
    const safePayload = JSON.stringify(redactForDiagnostics({ ...record(payload, 'event.payload'), source: actor.source, requestId: actor.requestId }, this.#env));
    this.#db.prepare('INSERT INTO ctx_events(entity,entity_id,task_id,type,actor,reason,payload,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(entity, id, taskId ?? null, type, actor.actorId, this.safeText(reason, 'reason'), safePayload, new Date().toISOString());
  }
  /** Owner operation: explicit registration is the durable repository allowlist. */
  async registerProject(input: ProjectRegistration, context: CommandActor, reason: string): Promise<RegisteredProject> {
    const actor = this.actor(context); const why = this.safeText(reason, 'reason');
    const value = record(input, 'project'); keys(value, ['id', 'repositoryPath', 'policyId', 'verificationProfile'], 'project');
    const id = identifier(this.label(value.id, 'project.id'), 'project.id'); const policyId = identifier(this.label(value.policyId, 'project.policyId'), 'project.policyId'); const profile = identifier(this.label(value.verificationProfile, 'project.verificationProfile'), 'project.verificationProfile');
    const path = text(value.repositoryPath, 'project.repositoryPath', 4096);
    if (!path.startsWith('/') || /[\x00-\x1f]/.test(path)) throw new ValidationError('project.repositoryPath', 'expected an absolute repository directory');
    let canonical: string;
    try { canonical = await realpath(path); if (!(await stat(canonical)).isDirectory()) throw new Error(); }
    catch { throw new CtxError('ENVIRONMENT_UNAVAILABLE', 'Repository directory is inaccessible'); }
    await ordinaryDirectory(canonical);
    const identity = await stat(canonical, { bigint: true });
    return this.write(() => {
      const rememberIdentity = () => {
        const prior = this.#db.prepare('SELECT device,inode FROM ctx_project_identities WHERE project_id=?').get(id) as { device: string; inode: string } | undefined;
        if (prior && (prior.device !== String(identity.dev) || prior.inode !== String(identity.ino))) throw new CtxError('CONFLICT', 'Registered source directory identity changed; explicit recovery is required');
        this.#db.prepare('INSERT INTO ctx_project_identities VALUES(?,?,?) ON CONFLICT(project_id) DO NOTHING').run(id, String(identity.dev), String(identity.ino));
        return !prior;
      };
      const existing = this.#db.prepare('SELECT * FROM ctx_projects WHERE id=? OR canonical_path=?').all(id, canonical) as unknown as ProjectRow[];
      if (existing.length) {
        const row = existing[0];
        if (existing.length !== 1 || row.id !== id || row.canonical_path !== canonical || row.policy_id !== policyId || row.test_profile !== profile) throw new CtxError('CONFLICT', 'Project registration conflicts with an existing identity, path or policy');
        if (rememberIdentity()) this.event('project', id, 'project.identity_bound', actor, why, { device: String(identity.dev), inode: String(identity.ino) });
        return this.project(row);
      }
      this.#db.prepare('INSERT INTO ctx_projects VALUES(?,?,?,?,?)').run(id, canonical, policyId, profile, new Date().toISOString());
      rememberIdentity();
      this.event('project', id, 'project.registered', actor, why, { policyId, verificationProfile: profile, device: String(identity.dev), inode: String(identity.ino) });
      return this.getProject(id);
    });
  }
  private project(row: ProjectRow): RegisteredProject {
    return { id: row.id, repositoryPath: row.canonical_path, policyId: row.policy_id, verificationProfile: row.test_profile, createdAt: row.created_at };
  }
  getProject(id: string): RegisteredProject {
    identifier(id, 'projectId');
    const row = this.#db.prepare('SELECT * FROM ctx_projects WHERE id=?').get(id) as unknown as ProjectRow | undefined;
    if (!row) throw new CtxError('NOT_FOUND', 'Project is not registered');
    return this.project(row);
  }
  getTask(id: string): TaskSnapshot {
    return this.read(() => this.task(id));
  }
  private task(id: string): TaskSnapshot {
    identifier(id, 'taskId');
    const row = this.#db.prepare('SELECT * FROM ctx_tasks WHERE id=?').get(id) as unknown as TaskRow | undefined;
    if (!row) throw new CtxError('NOT_FOUND', 'Task does not exist');
    const spec = parseTaskSpec(row.spec_json);
    const dependencies = (this.#db.prepare('SELECT prerequisite_id FROM ctx_task_dependencies WHERE task_id=? ORDER BY prerequisite_id').all(id) as { prerequisite_id: string }[]).map(item => item.prerequisite_id);
    if (row.id !== spec.id || row.project_id !== spec.projectId || row.priority !== spec.priority || JSON.stringify(dependencies) !== JSON.stringify([...spec.dependsOn].sort())) throw new CtxError('CONFLICT', 'Stored task identity or dependencies disagree with its specification');
    return { spec, state: choice(row.state, taskStates, 'storedTask.state'), revision: revision(row.revision), createdAt: row.created_at, updatedAt: row.updated_at,
      ...(row.reason === null ? {} : { reason: row.reason }), ...(row.next_run_at === null ? {} : { nextRunAt: row.next_run_at }) };
  }
  listTasks(limit = 100, after?: string): TaskSnapshot[] {
    integer(limit, 1, 100, 'limit'); if (after !== undefined) identifier(after, 'after');
    return this.read(() => {
      const rows = this.#db.prepare('SELECT id FROM ctx_tasks WHERE id > ? ORDER BY id LIMIT ?').all(after ?? '', limit) as { id: string }[];
      return rows.map(row => this.task(row.id));
    });
  }
  private dependencies(taskId: string, dependencies: string[]): void {
    const reaches = this.#db.prepare(`WITH RECURSIVE ancestors(id) AS (
      SELECT prerequisite_id FROM ctx_task_dependencies WHERE task_id=?
      UNION SELECT d.prerequisite_id FROM ctx_task_dependencies d JOIN ancestors a ON d.task_id=a.id
    ) SELECT id FROM ancestors WHERE id=? LIMIT 1`);
    for (const dependency of dependencies) {
      if (!this.#db.prepare('SELECT id FROM ctx_tasks WHERE id=?').get(dependency)) throw new CtxError('NOT_FOUND', 'A prerequisite task does not exist; submit prerequisites first');
      if (dependency === taskId || reaches.get(dependency, taskId)) throw new CtxError('CONFLICT', 'Task dependencies would form a cycle');
    }
  }
  submitTask(input: TaskSubmission, context: CommandActor): SubmissionResult {
    const actor = this.actor(context); const value = record(input, 'submission'); keys(value, ['spec', 'deduplicationKey', 'destination'], 'submission');
    const original = validateTaskSpec(value.spec); const serialized = serializeTaskSpec(original, this.#env); const spec = parseTaskSpec(serialized);
    if (spec.id !== original.id || spec.projectId !== original.projectId || JSON.stringify(spec.dependsOn) !== JSON.stringify(original.dependsOn)) throw new ValidationError('task', 'identity and dependency labels cannot contain credentials');
    if (spec.metadata.source !== actor.source) throw new ValidationError('task.metadata.source', 'must match the trusted ingress source');
    const key = this.label(value.deduplicationKey, 'submission.deduplicationKey');
    const destination = record(value.destination, 'submission.destination'); keys(destination, ['kind', 'address'], 'submission.destination');
    const route: Notification['destination'] = { kind: choice(destination.kind, ['local', 'discord'], 'submission.destination.kind'), address: this.label(destination.address, 'submission.destination.address') };
    const hash = digest(JSON.stringify({ spec, actor: actor.actorId, destination: route }));
    const acknowledgementKey = `accepted:${digest(JSON.stringify([actor.source, key]))}`;
    return this.write(() => {
      const seen = this.#db.prepare('SELECT payload_hash,task_id FROM ctx_inbox WHERE source=? AND external_event_id=?').get(actor.source, key) as { payload_hash: string; task_id: string } | undefined;
      if (seen) {
        if (seen.payload_hash !== hash) throw new CtxError('CONFLICT', 'Ingress deduplication key was already used for a different submission');
        const outbox = this.#db.prepare('SELECT id FROM ctx_outbox WHERE deduplication_key=?').get(acknowledgementKey) as { id: string } | undefined;
        if (!outbox) throw new CtxError('CONFLICT', 'Accepted submission is missing its durable acknowledgement');
        return { task: this.getTask(seen.task_id), duplicate: true, acknowledgement: this.getNotification(outbox.id) };
      }
      const project = this.getProject(spec.projectId);
      if (project.verificationProfile !== spec.verificationProfile) throw new CtxError('CONFLICT', 'Task verification profile differs from its registered project');
      if (this.#db.prepare('SELECT id FROM ctx_tasks WHERE id=?').get(spec.id)) throw new CtxError('CONFLICT', 'Task ID is already in use');
      this.dependencies(spec.id, spec.dependsOn);
      const now = new Date().toISOString();
      this.#db.prepare('INSERT INTO ctx_tasks(id,project_id,spec_json,revision,state,priority,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(spec.id, spec.projectId, serialized, 1, 'queued', spec.priority, now, now);
      for (const dependency of spec.dependsOn) this.#db.prepare('INSERT INTO ctx_task_dependencies VALUES(?,?,?)').run(spec.id, dependency, 'hard');
      this.event('task', spec.id, 'task.queued', actor, 'Task submitted with acceptance criteria', { revision: 1, dependsOn: spec.dependsOn }, spec.id);
      const notification: Notification = { id: randomUUID(), taskId: spec.id, destination: route, kind: 'accepted', deduplicationKey: acknowledgementKey, message: `Task ${spec.id} accepted: ${spec.title}`, createdAt: now, nextAttemptAt: now, retryCount: 0 };
      this.#db.prepare('INSERT INTO ctx_outbox(id,task_id,destination,kind,deduplication_key,payload,next_attempt_at,created_at) VALUES(?,?,?,?,?,?,?,?)').run(notification.id, spec.id, JSON.stringify(route), notification.kind, acknowledgementKey, JSON.stringify(notification), now, now);
      this.#db.prepare('INSERT INTO ctx_inbox VALUES(?,?,?,?,?)').run(actor.source, key, hash, spec.id, now);
      return { task: this.getTask(spec.id), duplicate: false, acknowledgement: notification };
    });
  }
  replaceDependencies(id: string, dependencies: string[], expectedRevision: number, context: CommandActor, reason: string): TaskSnapshot {
    identifier(id, 'taskId'); revision(expectedRevision); const actor = this.actor(context); const why = this.safeText(reason, 'reason');
    const next = list(dependencies, 'dependencies').map(item => identifier(item, 'dependencies'));
    return this.write(() => {
      const task = this.getTask(id); this.assertRevision(task, expectedRevision);
      if (!['draft', 'queued', 'waiting_dependency', 'paused', 'blocked'].includes(task.state) || this.hasActiveAttempt(id)) throw new CtxError('CONFLICT', 'Dependencies cannot change while work is eligible or active');
      this.dependencies(id, next);
      const spec = validateTaskSpec({ ...task.spec, dependsOn: next });
      this.#db.prepare('DELETE FROM ctx_task_dependencies WHERE task_id=?').run(id);
      for (const dependency of next) this.#db.prepare('INSERT INTO ctx_task_dependencies VALUES(?,?,?)').run(id, dependency, 'hard');
      const result = this.#db.prepare('UPDATE ctx_tasks SET spec_json=?,revision=revision+1,reason=?,updated_at=? WHERE id=? AND revision=?').run(serializeTaskSpec(spec, this.#env), why, new Date().toISOString(), id, expectedRevision);
      if (result.changes !== 1) throw new CtxError('CONFLICT', 'Task revision changed; reload before retrying');
      this.event('task', id, 'task.dependencies_changed', actor, why, { before: task.spec.dependsOn, after: next, revision: expectedRevision + 1 }, id);
      return this.getTask(id);
    });
  }
  private assertRevision(task: TaskSnapshot, expected: number): void {
    if (task.revision !== expected) throw new CtxError('CONFLICT', 'Task revision changed; reload before retrying');
  }
  private hasActiveAttempt(id: string): boolean {
    return !!this.#db.prepare("SELECT id FROM ctx_attempts WHERE task_id=? AND state IN ('leased','running','verifying')").get(id);
  }
  /** Administrative non-worker transitions. Worker claims/finalization require the later scheduler/verifier APIs. */
  transitionTask(id: string, to: TaskState, expectedRevision: number, context: CommandActor, reason: string): TaskSnapshot {
    identifier(id, 'taskId'); choice(to, taskStates, 'state'); revision(expectedRevision); const actor = this.actor(context); const why = this.safeText(reason, 'reason');
    return this.write(() => {
      const task = this.getTask(id); this.assertRevision(task, expectedRevision); assertTaskTransition(task.state, to);
      if (this.hasActiveAttempt(id) || ['leased', 'running', 'verifying', 'recovering', 'completed', 'failed', 'waiting_capacity', 'waiting_approval'].includes(to) || ['leased', 'running', 'verifying', 'recovering', 'waiting_capacity', 'waiting_approval'].includes(task.state)) throw new CtxError('CONFLICT', 'Transition requires the worker, capacity, approval or verification lifecycle API');
      if (to === 'ready' && this.#db.prepare("SELECT 1 FROM ctx_task_dependencies d JOIN ctx_tasks t ON t.id=d.prerequisite_id WHERE d.task_id=? AND t.state <> 'completed' LIMIT 1").get(id)) throw new CtxError('CONFLICT', 'Prerequisites have not completed');
      if (this.#db.prepare("SELECT id FROM ctx_approvals WHERE task_id=? AND decision='pending' LIMIT 1").get(id)) throw new CtxError('CONFLICT', 'Task has an outstanding approval');
      const result = this.#db.prepare('UPDATE ctx_tasks SET state=?,revision=revision+1,reason=?,updated_at=? WHERE id=? AND revision=?').run(to, why, new Date().toISOString(), id, expectedRevision);
      if (result.changes !== 1) throw new CtxError('CONFLICT', 'Task revision changed; reload before retrying');
      this.event('task', id, `task.${to}`, actor, why, { from: task.state, to, revision: expectedRevision + 1 }, id);
      return this.getTask(id);
    });
  }
  events(taskId?: string, afterSequence = 0, limit = 1000): AuditEvent[] {
    if (taskId !== undefined) identifier(taskId, 'taskId');
    integer(afterSequence, 0, Number.MAX_SAFE_INTEGER, 'afterSequence'); integer(limit, 1, 1000, 'limit');
    const rows = this.#db.prepare('SELECT * FROM ctx_events WHERE (? IS NULL OR task_id=?) AND sequence>? ORDER BY sequence LIMIT ?').all(taskId ?? null, taskId ?? null, afterSequence, limit) as { sequence: number; entity: string; entity_id: string; task_id: string | null; type: string; actor: string; reason: string; payload: string; created_at: string }[];
    return rows.map(row => ({ sequence: row.sequence, entity: row.entity, entityId: row.entity_id, ...(row.task_id === null ? {} : { taskId: row.task_id }), type: row.type, actor: row.actor, reason: row.reason, payload: JSON.parse(row.payload) as unknown, createdAt: row.created_at }));
  }
  getNotification(id: string): Notification {
    identifier(id, 'notificationId');
    const row = this.#db.prepare('SELECT * FROM ctx_outbox WHERE id=?').get(id) as { id: string; task_id: string; payload: string; destination: string; kind: string; deduplication_key: string; next_attempt_at: string; retry_count: number; created_at: string; remote_message_id: string | null; delivered_at: string | null } | undefined;
    if (!row) throw new CtxError('NOT_FOUND', 'Notification does not exist');
    const value = record(JSON.parse(row.payload) as unknown, 'notification'); const destination = record(value.destination, 'notification.destination');
    keys(value, ['id', 'taskId', 'destination', 'kind', 'deduplicationKey', 'message', 'createdAt', 'nextAttemptAt', 'retryCount', 'remoteMessageId', 'deliveredAt'], 'notification');
    keys(destination, ['kind', 'address'], 'notification.destination');
    if (value.id !== row.id || value.taskId !== row.task_id || value.kind !== row.kind || value.deduplicationKey !== row.deduplication_key || JSON.stringify(value.destination) !== row.destination) throw new CtxError('CONFLICT', 'Stored notification identity or routing is inconsistent');
    return { id: identifier(value.id, 'notification.id'), taskId: identifier(value.taskId, 'notification.taskId'), destination: { kind: choice(destination.kind, ['local', 'discord'], 'notification.destination.kind'), address: text(destination.address, 'notification.destination.address', 200) },
      kind: choice(value.kind, ['accepted', 'progress', 'completed', 'blocked', 'approval_requested', 'capacity_wait'], 'notification.kind'), deduplicationKey: text(value.deduplicationKey, 'notification.deduplicationKey', 200), message: text(value.message, 'notification.message'), createdAt: row.created_at, nextAttemptAt: row.next_attempt_at, retryCount: integer(row.retry_count, 0, Number.MAX_SAFE_INTEGER, 'notification.retryCount'),
      ...(row.remote_message_id === null ? {} : { remoteMessageId: row.remote_message_id }), ...(row.delivered_at === null ? {} : { deliveredAt: row.delivered_at }) };
  }
  pendingNotifications(limit = 100): Notification[] {
    integer(limit, 1, 100, 'limit');
    return (this.#db.prepare('SELECT id FROM ctx_outbox WHERE delivered_at IS NULL ORDER BY created_at,id LIMIT ?').all(limit) as { id: string }[]).map(row => this.getNotification(row.id));
  }
  artifacts(taskId?: string): ArtifactRecord[] {
    if (taskId !== undefined) identifier(taskId, 'taskId');
    const rows = this.#db.prepare('SELECT * FROM ctx_artifacts WHERE (? IS NULL OR task_id=?) ORDER BY id LIMIT ?').all(taskId ?? null, taskId ?? null, artifactPolicy.maxBackupFiles + 1) as { id: string; task_id: string; attempt_id: string | null; kind: string; location: string; sha256: string; bytes: number; created_at: string }[];
    if (rows.length > artifactPolicy.maxBackupFiles) throw new CtxError('BUDGET_EXHAUSTED', 'Artifact query exceeds the file budget');
    return rows.map(row => validateArtifact({ id: row.id, taskId: row.task_id, ...(row.attempt_id === null ? {} : { attemptId: row.attempt_id }), kind: row.kind, location: row.location, sha256: row.sha256, bytes: row.bytes, createdAt: row.created_at }));
  }
  async recordArtifact(input: ArtifactRecord, context: CommandActor): Promise<ArtifactRecord> {
    const descriptor = validateArtifact(input); const actor = this.actor(context); this.label(descriptor.kind, 'artifact.kind');
    const manifest = await verifyArtifact(this.dataDirectory, descriptor);
    const manifestSha256 = sha256(JSON.stringify(manifest));
    return this.write(() => {
      this.getTask(descriptor.taskId);
      if (descriptor.attemptId !== undefined) this.queue.assertArtifactOwner(descriptor.taskId, descriptor.attemptId);
      const existing = this.artifacts(descriptor.taskId).find(item => item.id === descriptor.id);
      if (existing) { if (JSON.stringify(existing) !== JSON.stringify(descriptor) || recordedManifestHash(this.#db, descriptor.id) !== manifestSha256) throw new CtxError('CONFLICT', 'Artifact identity is immutable'); return existing; }
      const size = this.#db.prepare('SELECT COALESCE(SUM(bytes),0) AS bytes FROM ctx_artifacts WHERE task_id=?').get(descriptor.taskId) as { bytes: number };
      if (size.bytes + descriptor.bytes > artifactPolicy.maxTaskBytes) throw new CtxError('BUDGET_EXHAUSTED', 'Task artifacts exceed the storage budget');
      this.#db.prepare('INSERT INTO ctx_artifacts VALUES(?,?,?,?,?,?,?,?)').run(descriptor.id, descriptor.taskId, descriptor.attemptId ?? null, descriptor.kind, descriptor.location, descriptor.sha256, descriptor.bytes, descriptor.createdAt);
      this.event('artifact', descriptor.id, 'artifact.recorded', actor, 'Published and hash-verified immutable artifact', { sha256: descriptor.sha256, manifestSha256, bytes: descriptor.bytes, kind: descriptor.kind }, descriptor.taskId);
      return descriptor;
    });
  }
  async verifyStoredArtifact(id: string) {
    identifier(id, 'artifactId'); const artifact = this.artifacts().find(item => item.id === id);
    if (!artifact) throw new CtxError('NOT_FOUND', 'Artifact does not exist');
    return verifyArtifact(this.dataDirectory, artifact, recordedManifestHash(this.#db, id));
  }
}
