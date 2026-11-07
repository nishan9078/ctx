import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, rename, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { historicalDatabase, copyHistoricalFixture } from '../fixtures/historical-database.js';
import { codexFixture } from '../fixtures/codex.js';
import { repositoryActor as actor, submissionFixture } from '../fixtures/repository.js';
import { TaskRepository } from '../../packages/persistence/src/task-repository.js';
import { ArtifactStore } from '../../packages/persistence/src/artifact-store.js';
import { openOrchestrationDatabase, currentSchemaVersion } from '../../packages/persistence/src/migrations.js';

const claim = (repository: Awaited<ReturnType<typeof codexFixture>>['repository'], ownerId: string) => repository.queue.claim({ ownerId, workerKind: 'codex', leaseMs: 10000 }, actor)!;
test('workspace reservation is fenced, audited, exclusive and released only when the attempt settles', async () => {
  const f = await codexFixture();
  try {
    f.repository.queue.configure({ maxWorkers: 2, maxWorkersPerProject: 2 }, actor);
    f.repository.submitTask(submissionFixture('other'), actor); f.repository.queue.refresh(actor);
    const first = claim(f.repository, 'first'); const second = claim(f.repository, 'second');
    f.repository.queue.start(first, actor); f.repository.queue.start(second, actor);
    const workspace = f.repository.workspaces.reserve(first, actor);
    assert.equal(workspace.identity.root, join(f.repository.dataDirectory, 'codex-work', first.attempt.id));
    assert.throws(() => f.repository.workspaces.acquire(second, workspace.id, actor));
    assert.throws(() => f.repository.workspaces.reserve({ ...first, fencingToken: 99 }, actor));
    const ready = f.repository.workspaces.ready(first, workspace.id, { ...workspace.identity, device: '1', inode: '2', baseSha: 'a'.repeat(40), branch: `ctx/${first.task.spec.id}/${first.attempt.id}` }, actor);
    assert.equal(ready.state, 'ready'); assert.throws(() => f.repository.workspaces.assertQuiescent(workspace.id));
    const artifact = await (await ArtifactStore.open(f.repository.dataDirectory)).writeBinary({ taskId: first.task.spec.id, attemptId: first.attempt.id, kind: 'workspace-package' }, Buffer.from('deterministic contract fixture'), f.repository, actor);
    f.repository.workspaces.archive(workspace.id, artifact.id, 'b'.repeat(64), actor, first);
    f.repository.queue.settle(first, { kind: 'blocked', reason: 'Fixture stopped safely' }, actor);
    f.repository.workspaces.assertQuiescent(workspace.id);
    assert.throws(() => f.repository.workspaces.beginCleanup(workspace.id, actor, 0), /terminal/);
    const task = f.repository.getTask(first.task.spec.id); f.repository.queue.controlTask(task.spec.id, 'cancel', task.revision, actor, 'Owner cancelled retained fixture');
    assert.equal(f.repository.workspaces.beginCleanup(workspace.id, actor, 0).state, 'cleanup');
    f.repository.workspaces.removed(workspace.id, actor); f.repository.workspaces.removed(workspace.id, actor);
    assert.equal(f.repository.workspaces.get(workspace.id).state, 'removed');
    assert.throws(() => f.repository.workspaces.acquire(first, workspace.id, actor));
    f.repository.queue.settle(second, { kind: 'blocked', reason: 'Fixture stopped safely' }, actor);
  } finally { await f.cleanup(); }
});
test('ownership intent and workspace access roll back together if immutable audit insertion fails', async () => {
  const f = await codexFixture(); const db = new DatabaseSync(f.filename);
  try {
    const current = claim(f.repository, 'test'); f.repository.queue.start(current, actor);
    db.exec("CREATE TRIGGER fail_workspace_audit BEFORE INSERT ON ctx_events WHEN NEW.type='workspace.reserved' BEGIN SELECT RAISE(ABORT,'injected'); END;");
    assert.throws(() => f.repository.workspaces.reserve(current, actor)); assert.deepEqual(f.repository.workspaces.list(), []);
    assert.equal((db.prepare('SELECT count(*) AS n FROM ctx_workspace_access').get() as { n: number }).n, 0);
    f.repository.queue.settle(current, { kind: 'blocked', reason: 'Fixture safely stopped' }, actor);
  } finally { db.close(); await f.cleanup(); }
});
test('project inode replacement or symlink substitution blocks claims without changing owner files', async () => {
  for (const alias of [false, true]) {
    const f = await codexFixture();
    try {
      await rename(f.project, join(f.root, 'preserved-project'));
      if (alias) await symlink(join(f.root, 'preserved-project'), f.project); else await mkdir(f.project);
      f.repository.queue.refresh(actor); assert.equal(f.repository.getTask('task').state, 'blocked');
      assert.equal(claim(f.repository, 'test'), undefined);
    } finally { await f.cleanup(); }
  }
});
test('schema 5 migrates with historical event/session preservation and requires explicit project identity registration', async () => {
  const f = await codexFixture();
  const previous = claim(f.repository, 'historical'); f.repository.queue.start(previous, actor);
  f.repository.queue.recordSession(previous, { externalSessionId: 'schema5-thread', version: '0.166.0' });
  f.repository.queue.appendWorkerEvent(previous, { kind: 'diagnostic', type: 'historical', payload: { retained: true }, deliveryId: 'historical' });
  f.repository.queue.settle(previous, { kind: 'blocked', reason: 'Historical stopped attempt' }, actor);
  f.repository.close();
  try {
    const historical = join(f.root, 'historical.sqlite'); const db = historicalDatabase(historical, 5);
    copyHistoricalFixture(f.filename, db, ['ctx_projects','ctx_tasks','ctx_attempts','ctx_harness_sessions','ctx_worker_events','ctx_events','ctx_outbox']); db.close();
    const upgraded = await openOrchestrationDatabase(historical);
    try {
      assert.equal(upgraded.migratedFrom, 5); assert.ok(upgraded.backupPath);
      assert.equal((upgraded.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, currentSchemaVersion);
      assert.equal((upgraded.db.prepare('SELECT count(*) AS n FROM ctx_projects').get() as { n: number }).n, 1);
      assert.equal((upgraded.db.prepare('SELECT count(*) AS n FROM ctx_project_identities').get() as { n: number }).n, 0);
      assert.deepEqual(upgraded.db.prepare('PRAGMA foreign_key_check').all(), []);
      assert.equal((upgraded.db.prepare('SELECT external_session_id FROM ctx_harness_sessions WHERE attempt_id=?').get(previous.attempt.id) as { external_session_id: string }).external_session_id, 'schema5-thread');
      assert.equal((upgraded.db.prepare('SELECT count(*) AS n FROM ctx_worker_events WHERE attempt_id=?').get(previous.attempt.id) as { n: number }).n, 1);
    } finally { upgraded.db.close(); }
    const reopened = await TaskRepository.open(historical);
    try {
      reopened.submitTask(submissionFixture('needs-registration'), actor); reopened.queue.refresh(actor);
      assert.equal(reopened.getTask('needs-registration').state, 'blocked');
      await reopened.registerProject({ id: 'fixture', repositoryPath: f.project, policyId: 'safe', verificationProfile: 'node-api' }, actor, 'Owner revalidated migrated project identity');
      assert.ok(reopened.events().some(event => event.type === 'project.identity_bound' && event.actor === actor.actorId));
      const task = reopened.getTask('needs-registration'); reopened.queue.controlTask(task.spec.id, 'retry', task.revision, actor, 'Owner retried after identity validation'); reopened.queue.refresh(actor);
      assert.equal(reopened.getTask('needs-registration').state, 'ready');
    } finally { reopened.close(); }
  } finally { const { rm } = await import('node:fs/promises'); await rm(f.root, { recursive: true, force: true }); }
});
