import { DatabaseSync } from 'node:sqlite';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { schema } from './schema.js';
import { redact } from '../../shared/src/redact.js';
import { assertTransition, assertStepTransition } from '../../shared/src/legacy-transitions.js';
import type { TaskRecord } from './task-record.js';
import { closeSync, constants, existsSync, fstatSync, openSync, readSync } from 'node:fs';
import { dirname, join } from 'node:path';
export interface StoredEvent { sequence: number; timestamp: string; type: string; data: unknown }
export class TaskStore {
  readonly db: DatabaseSync;
  constructor(path: string) {
    const marker = join(dirname(path), 'restore-info.json');
    if (existsSync(marker)) {
      let archived = true;
      let handle: number | undefined;
      try {
        handle = openSync(marker, constants.O_RDONLY | constants.O_NOFOLLOW); const info = fstatSync(handle);
        if (!info.isFile() || info.size > 8 * 1024 * 1024) throw new Error('Invalid restore metadata');
        const buffer = Buffer.alloc(info.size + 1); let total = 0;
        while (total < buffer.length) { const count = readSync(handle, buffer, total, buffer.length - total, null); if (!count) break; total += count; }
        if (total !== info.size) throw new Error('Restore metadata changed');
        const value = JSON.parse(buffer.subarray(0, total).toString('utf8')) as { legacyArchivedIds?: unknown };
        archived = !Array.isArray(value.legacyArchivedIds) || value.legacyArchivedIds.length > 0;
      } catch { /* Unknown recovery state remains blocked. */ } finally { if (handle !== undefined) closeSync(handle); }
      if (archived) throw new Error('Restored legacy tasks are archived for review. Inspect restore-info.json and preserved legacy evidence; explicitly reconcile worktrees and process ownership before enabling the legacy runner.');
    }
    this.db = new DatabaseSync(path);
    const version = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    if (version.user_version > 3) { this.db.close(); throw new Error('Unsupported database schema version'); }
    this.db.exec(schema);
    if (version.user_version < 2) this.transaction(() => {
      if ((this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version >= 2) return;
      this.db.exec("ALTER TABLE resources ADD COLUMN status TEXT NOT NULL DEFAULT 'ready'");
      this.db.exec("ALTER TABLE resources ADD COLUMN data TEXT NOT NULL DEFAULT '{}'");
      this.db.exec('PRAGMA user_version=2');
    });
  }
  close(): void { this.db.close(); }
  transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = work(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  get(id: string): TaskRecord {
    const row = this.db.prepare('SELECT data FROM tasks WHERE id=?').get(id) as { data: string } | undefined;
    if (!row) throw new Error(`Unknown task: ${id}`);
    return JSON.parse(row.data) as TaskRecord;
  }
  list(): TaskRecord[] { return (this.db.prepare('SELECT data FROM tasks ORDER BY rowid DESC').all() as { data: string }[]).map(row => JSON.parse(row.data)); }
  create(task: TaskRecord): void {
    this.transaction(() => {
      this.db.prepare('INSERT INTO tasks VALUES(?,?,?)').run(task.id, task.status, JSON.stringify(task));
      this.db.prepare('INSERT INTO plans VALUES(?,?,?)').run(task.id, task.plan.version, JSON.stringify(task.plan));
      this.save(task); this.journal(task, 'task.queued', { id: task.id });
    });
  }
  private save(task: TaskRecord): void {
    this.db.prepare('UPDATE tasks SET status=?,data=? WHERE id=?').run(task.status, JSON.stringify(task), task.id);
    for (const step of task.plan.steps) this.db.prepare('INSERT INTO steps VALUES(?,?,?,?) ON CONFLICT(task_id,id) DO UPDATE SET status=excluded.status,data=excluded.data').run(task.id, step.id, step.status, JSON.stringify(step));
    for (const attempt of task.attempts) this.db.prepare('INSERT INTO attempts VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data').run(attempt.id, task.id, attempt.stepId, attempt.idempotencyKey, attempt.status, JSON.stringify(attempt));
    this.db.prepare('INSERT OR IGNORE INTO resources(task_id,path,kind,status) VALUES(?,?,?,?)').run(task.id, task.workspacePath, 'workspace', task.prepared ? 'ready' : 'intent');
    this.db.prepare('UPDATE resources SET status=? WHERE task_id=? AND path=?').run(task.prepared ? 'ready' : 'intent', task.id, task.workspacePath);
    for (const resource of task.environment?.resources ?? []) this.db.prepare('INSERT INTO resources(task_id,path,kind,status,data) VALUES(?,?,?,?,?) ON CONFLICT(task_id,path) DO UPDATE SET status=excluded.status,data=excluded.data').run(task.id, resource.name, resource.kind, resource.status, JSON.stringify(resource));
  }
  private journal(task: TaskRecord, type: string, data: unknown): void {
    const inserted = this.db.prepare('INSERT INTO events(task_id,timestamp,type,data) VALUES(?,?,?,?)').run(task.id, new Date().toISOString(), type, redact(JSON.stringify(data)));
    this.db.prepare('INSERT INTO checkpoints(task_id,event_sequence,data) VALUES(?,?,?)').run(task.id, inserted.lastInsertRowid, JSON.stringify(task));
  }
  update(id: string, owner: string, type: string, data: unknown, mutate: (task: TaskRecord) => void = () => {}): TaskRecord {
    return this.transaction(() => {
      this.assertOwner(id, owner);
      const task = this.get(id); const before = structuredClone(task);
      mutate(task);
      if (JSON.stringify(task.commands) !== JSON.stringify(before.commands) || JSON.stringify(task.verificationPolicy) !== JSON.stringify(before.verificationPolicy)) throw new Error('Verification requirements are immutable');
      if (before.verificationPlan && !task.verificationPlan) throw new Error('Resolved verification plan cannot be erased');
      if (before.verificationPolicy?.plan && task.verificationPlan) { for (const check of [...before.verificationPolicy.plan.checks, ...(before.verificationPlan?.checks ?? [])].filter(item => item.requirement === 'mandatory' && (item.kind === 'command' || item.kind === 'browser'))) { const resolved = task.verificationPlan.checks.find(item => item.id === check.id); if (!resolved || resolved.requirement !== 'mandatory' || resolved.command !== check.command) throw new Error('Mandatory verification checks cannot be removed or replaced'); } }
      assertTransition(before.status, task.status);
      if (before.environment) {
        if (!task.environment || JSON.stringify(before.environment.config) !== JSON.stringify(task.environment.config)) throw new Error('Environment configuration is immutable');
        const expectedRecoveryBudget = before.environment.remainingRecoveryAttempts - (type === 'environment.recovery.intent' ? 1 : 0);
        if (task.environment.remainingRecoveryAttempts !== expectedRecoveryBudget || expectedRecoveryBudget < 0) throw new Error('Invalid environment recovery budget change');
      }
      const repairing = before.status === 'verifying' && task.status === 'repairing';
      const expectedBudget = before.remainingRepairAttempts - (repairing ? 1 : 0);
      if (task.maxRepairAttempts !== before.maxRepairAttempts || task.remainingRepairAttempts < 0 || task.remainingRepairAttempts !== expectedBudget) throw new Error('Invalid repair budget change');
      if (task.plan.version !== before.plan.version || task.plan.steps.length !== before.plan.steps.length) throw new Error('Plan changes require a new validated version');
      for (const step of task.plan.steps) {
        const old = before.plan.steps.find(item => item.id === step.id);
        if (!old) throw new Error(`Unknown step ID: ${step.id}`);
        assertStepTransition(old.status, step.status);
        if (old.status !== step.status && step.status === 'pending' && !repairing) throw new Error('Steps may only reset during budgeted repair');
        const { status: oldStatus, ...oldDefinition } = old;
        const { status: newStatus, ...newDefinition } = step;
        if (JSON.stringify(oldDefinition) !== JSON.stringify(newDefinition)) throw new Error('Plan definition is immutable');
      }
      task.updatedAt = new Date().toISOString(); this.save(task); this.journal(task, type, data); return task;
    });
  }
  events(id: string): StoredEvent[] {
    return (this.db.prepare('SELECT sequence,timestamp,type,data FROM events WHERE task_id=? ORDER BY sequence').all(id) as { sequence: number; timestamp: string; type: string; data: string }[]).map(row => ({ ...row, data: JSON.parse(row.data) }));
  }
  claim(id: string, durationMs: number): string {
    return this.transaction(() => {
      this.get(id);
      const lease = this.db.prepare('SELECT * FROM leases WHERE task_id=?').get(id) as { pid: number; host: string; expires_at: number } | undefined;
      if (lease) {
        let alive = true;
        if (lease.host === hostname()) {
          try { process.kill(lease.pid, 0); } catch (error) { alive = (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
        }
        if (lease.expires_at > Date.now() || alive) throw new Error('Task lease is held by another worker; wait for expiry and ensure the previous worker has exited');
      }
      const owner = randomUUID();
      this.db.prepare('INSERT OR REPLACE INTO leases VALUES(?,?,?,?,?)').run(id, owner, process.pid, hostname(), Date.now() + durationMs);
      return owner;
    });
  }
  private assertOwner(id: string, owner: string): void {
    const row = this.db.prepare('SELECT owner FROM leases WHERE task_id=?').get(id) as { owner: string } | undefined;
    if (row?.owner !== owner) throw new Error('Worker lost task lease');
  }
  heartbeat(id: string, owner: string, durationMs: number): void {
    this.transaction(() => { this.assertOwner(id, owner); this.db.prepare('UPDATE leases SET expires_at=? WHERE task_id=? AND owner=?').run(Date.now() + durationMs, id, owner); });
  }
  release(id: string, owner: string): void { this.db.prepare('DELETE FROM leases WHERE task_id=? AND owner=?').run(id, owner); }
  artifact(id: string, owner: string, path: string, checksum: string, kind: string): void {
    this.transaction(() => { this.assertOwner(id, owner); this.db.prepare('INSERT OR REPLACE INTO artifacts VALUES(?,?,?,?)').run(id, path, checksum, kind); });
  }
}
