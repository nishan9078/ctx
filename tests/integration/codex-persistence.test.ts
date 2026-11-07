import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { TaskRepository } from '../../packages/persistence/src/task-repository.js';
import { openOrchestrationDatabase, migrations } from '../../packages/persistence/src/migrations.js';
import { createBackup, restoreBackup } from '../../packages/persistence/src/backup.js';
import { sha256 } from '../../packages/persistence/src/artifact-files.js';
import { repositoryActor as actor } from '../fixtures/repository.js';
import { historicalDatabase } from '../fixtures/historical-database.js';
import { codexFixture } from '../fixtures/codex.js';

test('worker events and sessions are fenced, replayable and survive reopen; handoff never completes task', async () => {
  const f = await codexFixture();
  try {
    const claim = f.repository.queue.claim({ ownerId: 'test', workerKind: 'codex', leaseMs: 10000 }, actor)!;
    f.repository.queue.start(claim, actor);
    const event = { kind: 'diagnostic' as const, type: 'turn.started', payload: { message: 'begin' }, deliveryId: 'one' };
    assert.equal(f.repository.queue.appendWorkerEvent(claim, event).sequence, 1);
    assert.equal(f.repository.queue.appendWorkerEvent(claim, event).sequence, 1);
    assert.throws(() => f.repository.queue.appendWorkerEvent(claim, { ...event, payload: 'conflict' }));
    f.repository.queue.recordSession(claim, { externalSessionId: 'thread-1', version: '0.166.0' });
    assert.throws(() => f.repository.queue.recordSession(claim, { externalSessionId: 'thread-2', version: '0.166.0' }));
    const reopened = await TaskRepository.open(f.filename);
    try { assert.equal(reopened.queue.session(claim.attempt.id)?.externalSessionId, 'thread-1'); assert.equal(reopened.queue.workerEvents(claim.attempt.id).length, 1); } finally { reopened.close(); }
    const canonical = { kind: 'canonical' as const, type: 'message_delta', deliveryId: 'canonical', payload: { type: 'message_delta', taskId: 'task', attemptId: claim.attempt.id, timestamp: new Date().toISOString(), sequence: 0, text: '' } };
    assert.equal(f.repository.queue.appendWorkerEvent(claim, canonical).sequence, 2);
    assert.equal(f.repository.queue.appendWorkerEvent(claim, canonical).sequence, 2);
    assert.deepEqual((f.repository.queue.workerEvents(claim.attempt.id)[1].payload as { text: string; sequence: number }).text, '');
    assert.throws(() => f.repository.queue.appendWorkerEvent({ ...claim, fencingToken: claim.fencingToken + 1 }, event));
    f.repository.queue.beginVerification(claim, actor);
    f.repository.queue.blockVerificationHandoff(claim, actor, { reason: 'Independent verification pending' });
    assert.equal(f.repository.getTask('task').state, 'blocked'); assert.equal(f.repository.queue.status().running, 0);
    assert.throws(() => f.repository.queue.appendWorkerEvent(claim, event));
  } finally { await f.cleanup(); }
});
test('schema 4 backup remains restorable and migrates to the current schema with a backup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ctx-v4-backup-')); const filename = join(root, 'state.sqlite');
  try {
    const db = historicalDatabase(filename, 4); db.close();
    const backup = await createBackup(filename, join(root, 'bundle')); assert.equal(backup.manifest.databaseVersion, 4);
    const restored = await restoreBackup(join(root, 'bundle'), join(root, 'restored'));
    const upgraded = await openOrchestrationDatabase(restored.database);
    try {
      assert.equal(upgraded.migratedFrom, 4); assert.ok(upgraded.backupPath);
      assert.equal((upgraded.db.prepare('SELECT sha256 FROM ctx_schema_migrations WHERE version=?').get(migrations.at(-1)!.version) as { sha256: string }).sha256, sha256(migrations.at(-1)!.sql));
    } finally { upgraded.db.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('dead scheduler recovery holds capacity while its recorded worker remains alive or unobservable', async () => {
  const f = await codexFixture(); const { processIdentity } = await import('../../packages/persistence/src/process-identity.js'); const { hostname } = await import('node:os');
  try {
    const claim = f.repository.queue.claim({ ownerId: 'owner', workerKind: 'codex', leaseMs: 10000 }, actor)!; f.repository.queue.start(claim, actor);
    f.repository.queue.recordWorkerProcess(claim, { pid: process.pid, pgid: process.pid, host: hostname(), identity: processIdentity(), startedAt: new Date().toISOString() });
    const db = new DatabaseSync(f.filename);
    try {
      db.exec("UPDATE ctx_leases SET owner_pid=99999999,expires_at='2000-01-01T00:00:00.000Z'");
      assert.equal(f.repository.queue.reconcile(actor).alive, 1); assert.equal(f.repository.queue.status().running, 1);
      db.exec("UPDATE ctx_worker_processes SET host='foreign-host'");
      assert.equal(f.repository.queue.reconcile(actor).unknown, 1); assert.equal(f.repository.queue.status().running, 1);
      db.exec('DELETE FROM ctx_worker_processes');
      assert.equal(f.repository.queue.reconcile(actor).recovered, 1); assert.equal(f.repository.getTask('task').state, 'blocked');
    } finally { db.close(); }
  } finally { await f.cleanup(); }
});
