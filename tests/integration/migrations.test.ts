import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openOrchestrationDatabase, migrations, currentSchemaVersion } from '../../packages/persistence/src/migrations.js';
import { TaskStore } from '../../packages/persistence/src/database.js';
import type { TaskRecord } from '../../packages/persistence/src/task-record.js';
import { CtxError } from '../../packages/shared/src/errors.js';

const legacyTask = (root: string): TaskRecord => ({
  id: 'legacy-task', request: 'Preserve this task', repositoryPath: root, directory: root, workspacePath: join(root, 'workspace'),
  status: 'queued', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), plan: { version: 1, steps: [{ id: 'implement', title: 'Implement', instructions: 'Do work', dependencies: [], acceptanceCriteria: ['Checks pass'], status: 'pending' }] },
  commands: {}, prepared: false, maxRepairAttempts: 0, remainingRepairAttempts: 0, attempts: [], verification: [], timeoutMs: 60000, elapsedMs: 0,
});
const version = (db: DatabaseSync) => (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
test('fresh V1 database initializes durable settings and all tables without a legacy task import', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ctx-schema-')); const filename = join(root, 'state.sqlite');
  try {
    const opened = await openOrchestrationDatabase(filename);
    try {
      assert.equal(opened.migratedFrom, 0); assert.equal(opened.backupPath, undefined); assert.equal(version(opened.db), currentSchemaVersion);
      assert.equal((opened.db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode, 'wal');
      assert.equal((opened.db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys, 1);
      assert.equal((opened.db.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout, 5000);
      assert.equal((opened.db.prepare('PRAGMA synchronous').get() as { synchronous: number }).synchronous, 2);
      const tables = (opened.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(row => row.name);
      for (const name of ['projects', 'tasks', 'task_dependencies', 'attempts', 'leases', 'events', 'outbox', 'inbox', 'approvals', 'checkpoints', 'artifacts', 'capacity_states', 'verification_runs', 'verification_steps', 'harness_sessions', 'scheduler_locks', 'settings']) assert.ok(tables.includes(`ctx_${name}`), name);
      assert.equal((opened.db.prepare('SELECT COUNT(*) AS n FROM ctx_tasks').get() as { n: number }).n, 0);
      assert.equal((await stat(filename)).mode & 0o777, 0o600);
    } finally { opened.db.close(); }
    const reopened = await openOrchestrationDatabase(filename);
    try { assert.equal(reopened.migratedFrom, currentSchemaVersion); assert.equal(reopened.backupPath, undefined); } finally { reopened.db.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('v2 migration backs up committed WAL state and preserves legacy task/event data and APIs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ctx-migrate-')); const filename = join(root, 'state.sqlite');
  const legacy = new TaskStore(filename); const task = legacyTask(root); legacy.create(task);
  try {
    const opened = await openOrchestrationDatabase(filename);
    try {
      assert.equal(opened.migratedFrom, 2); assert.ok(opened.backupPath);
      assert.equal((await stat(opened.backupPath)).mode & 0o777, 0o600);
      const snapshot = new DatabaseSync(opened.backupPath, { readOnly: true });
      try {
        assert.equal(version(snapshot), 2);
        assert.deepEqual(JSON.parse((snapshot.prepare('SELECT data FROM tasks WHERE id=?').get(task.id) as { data: string }).data), task);
        assert.equal((snapshot.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n, 1);
        assert.equal((snapshot.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok');
      } finally { snapshot.close(); }
      assert.equal((opened.db.prepare('SELECT COUNT(*) AS n FROM ctx_tasks').get() as { n: number }).n, 0);
    } finally { opened.db.close(); }
    const compatibility = new TaskStore(filename);
    try {
      assert.deepEqual(compatibility.get(task.id), task);
      const owner = compatibility.claim(task.id, 5000);
      compatibility.update(task.id, owner, 'task.planning', { status: 'planning' }, value => { value.status = 'planning'; }); compatibility.release(task.id, owner);
      assert.equal(compatibility.get(task.id).status, 'planning'); assert.equal(compatibility.events(task.id).length, 2);
    } finally { compatibility.close(); }
    assert.equal((await readdir(join(root, 'migration-backups'))).length, 1);
  } finally { legacy.close(); await rm(root, { recursive: true, force: true }); }
});
test('v1 legacy resource migration remains lossless on the V1 initialization path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ctx-v1-migrate-')); const filename = join(root, 'state.sqlite');
  try {
    const legacy = new DatabaseSync(filename);
    legacy.exec("CREATE TABLE resources(task_id TEXT NOT NULL,path TEXT NOT NULL,kind TEXT NOT NULL,PRIMARY KEY(task_id,path)); INSERT INTO resources VALUES('legacy-task','/retained/workspace','workspace'); PRAGMA user_version=1;"); legacy.close();
    const opened = await openOrchestrationDatabase(filename);
    try {
      assert.equal(version(opened.db), currentSchemaVersion); assert.ok(opened.backupPath);
      assert.deepEqual({ ...opened.db.prepare('SELECT path,status,data FROM resources').get() }, { path: '/retained/workspace', status: 'ready', data: '{}' });
    } finally { opened.db.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('malformed migration rolls back all schema/version/history changes and keeps a recoverable backup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ctx-bad-migrate-')); const filename = join(root, 'state.sqlite');
  const legacy = new TaskStore(filename); const task = legacyTask(root); legacy.create(task); legacy.close();
  try {
    await assert.rejects(openOrchestrationDatabase(filename, [...migrations.slice(0, -1), { version: currentSchemaVersion, name: 'bad', sql: 'CREATE TABLE partial_schema(id TEXT); INVALID SQL;' }]));
    const db = new DatabaseSync(filename);
    try {
      assert.equal(version(db), 2);
      assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name IN ('partial_schema','ctx_schema_migrations')").all().length, 0);
      assert.equal((db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n, 1);
      assert.equal((db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok');
    } finally { db.close(); }
    const directories = await readdir(join(root, 'migration-backups')); assert.equal(directories.length, 1);
    const snapshot = new DatabaseSync(join(root, 'migration-backups', directories[0], 'state.sqlite'), { readOnly: true });
    try { assert.equal(version(snapshot), 2); } finally { snapshot.close(); }
    const retried = await openOrchestrationDatabase(filename); retried.db.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('startup rejects future versions, unversioned nonempty databases, and changed migration history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ctx-refuse-migrate-'));
  try {
    for (const [name, sql] of [['future', `PRAGMA user_version=${currentSchemaVersion + 1};`], ['unknown', 'CREATE TABLE human_data(value TEXT);']] as const) {
      const filename = join(root, name + '.sqlite'); const db = new DatabaseSync(filename); db.exec(sql); db.close();
      await assert.rejects(openOrchestrationDatabase(filename), error => error instanceof CtxError && error.code === 'UNSUPPORTED_SCHEMA');
    }
    const filename = join(root, 'valid.sqlite'); const opened = await openOrchestrationDatabase(filename);
    opened.db.exec("UPDATE ctx_schema_migrations SET sha256='changed' WHERE version=3"); opened.db.close();
    await assert.rejects(openOrchestrationDatabase(filename), error => error instanceof CtxError && error.code === 'CONFLICT');
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('migration refuses outstanding legacy leases instead of guessing worker liveness', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ctx-live-migrate-')); const filename = join(root, 'state.sqlite');
  const legacy = new TaskStore(filename); const task = legacyTask(root); legacy.create(task); const owner = legacy.claim(task.id, 5000);
  try {
    await assert.rejects(openOrchestrationDatabase(filename), error => error instanceof CtxError && error.code === 'CONFLICT');
    assert.equal(version(legacy.db), 2); legacy.release(task.id, owner);
    const opened = await openOrchestrationDatabase(filename); opened.db.close();
  } finally { legacy.close(); await rm(root, { recursive: true, force: true }); }
});
test('V1 schema enforces references, deduplication, one active attempt, and immutable events', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ctx-constraints-')); const opened = await openOrchestrationDatabase(join(root, 'state.sqlite')); const db = opened.db;
  try {
    const now = new Date().toISOString();
    assert.throws(() => db.prepare('INSERT INTO ctx_tasks(id,project_id,spec_json,revision,state,priority,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run('task', 'unknown', '{}', 1, 'queued', 'normal', now, now), /FOREIGN KEY/);
    db.prepare('INSERT INTO ctx_projects VALUES(?,?,?,?,?)').run('project', root, 'safe', 'node', now);
    db.prepare('INSERT INTO ctx_tasks(id,project_id,spec_json,revision,state,priority,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run('task', 'project', '{}', 1, 'queued', 'normal', now, now);
    const addAttempt = db.prepare('INSERT INTO ctx_attempts(id,task_id,sequence,task_revision,state,harness_id,provider_key,model_id,fencing_token,started_at) VALUES(?,?,?,?,?,?,?,?,?,?)');
    addAttempt.run('attempt-1', 'task', 1, 1, 'running', 'codex', 'account/model', 'model', 1, now);
    assert.throws(() => addAttempt.run('attempt-2', 'task', 2, 1, 'leased', 'codex', 'account/model', 'model', 2, now), /UNIQUE/);
    assert.throws(() => db.prepare('INSERT INTO ctx_leases(task_id,attempt_id,owner_id,fencing_token,expires_at,last_heartbeat) VALUES(?,?,?,?,?,?)').run('task', 'attempt-1', 'owner', 2, now, now), /FOREIGN KEY/);
    db.prepare('INSERT INTO ctx_leases(task_id,attempt_id,owner_id,fencing_token,expires_at,last_heartbeat) VALUES(?,?,?,?,?,?)').run('task', 'attempt-1', 'owner', 1, now, now);
    db.prepare('INSERT INTO ctx_tasks(id,project_id,spec_json,revision,state,priority,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run('other-task', 'project', '{}', 1, 'queued', 'normal', now, now);
    assert.throws(() => db.prepare('INSERT INTO ctx_artifacts VALUES(?,?,?,?,?,?,?,?)').run('artifact', 'other-task', 'attempt-1', 'patch', 'patch.diff', 'b'.repeat(64), 10, now), /FOREIGN KEY/);
    db.prepare('INSERT INTO ctx_inbox VALUES(?,?,?,?,?)').run('cli', 'event-1', 'a'.repeat(64), 'task', now);
    assert.throws(() => db.prepare('INSERT INTO ctx_inbox VALUES(?,?,?,?,?)').run('cli', 'event-1', 'a'.repeat(64), 'task', now), /UNIQUE/);
    db.prepare('INSERT INTO ctx_events(entity,entity_id,task_id,type,actor,reason,payload,created_at) VALUES(?,?,?,?,?,?,?,?)').run('task', 'task', 'task', 'task.queued', 'owner', 'Submitted', '{}', now);
    assert.throws(() => db.exec("UPDATE ctx_events SET reason='Changed'"), /immutable/);
    assert.throws(() => db.exec('DELETE FROM ctx_events'), /immutable/);
    assert.throws(() => db.prepare('INSERT INTO ctx_task_dependencies VALUES(?,?,?)').run('task', 'task', 'hard'), /CHECK/);
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});
