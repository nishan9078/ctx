import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fork, execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify, inspect } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { ArtifactStore } from '../../packages/persistence/src/artifact-store.js';
import { TaskRepository } from '../../packages/persistence/src/task-repository.js';
import { TaskStore } from '../../packages/persistence/src/database.js';
import { createBackup, restoreBackup } from '../../packages/persistence/src/backup.js';
import { verifyArtifact, sha256 } from '../../packages/persistence/src/artifact-files.js';
import { artifactPolicy } from '../../packages/shared/src/artifacts.js';
import { CtxError } from '../../packages/shared/src/errors.js';
import type { TaskRecord } from '../../packages/persistence/src/task-record.js';
import { repositoryActor as actor, repositoryTaskId, submissionFixture } from '../fixtures/repository.js';
const execute = promisify(execFile);
const code = (expected: CtxError['code']) => (error: unknown) => error instanceof CtxError && error.code === expected;
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ctx-artifacts-')); const source = join(root, 'source'); await mkdir(source, { mode: 0o700 });
  const filename = join(source, 'state.sqlite'); const repository = await TaskRepository.open(filename, { SERVICE_TOKEN: 'fixture-private-credential' });
  await repository.registerProject({ id: 'fixture', repositoryPath: source, policyId: 'safe', verificationProfile: 'node-api' }, actor, 'Fixture registration');
  repository.submitTask(submissionFixture('first'), actor); const store = await ArtifactStore.open(source, { SERVICE_TOKEN: 'fixture-private-credential' });
  return { root, source, filename, repository, store, async cleanup() { repository.close(); await rm(root, { recursive: true, force: true }); } };
}
test('artifact publication redacts text before hashing, persists manifests/audit and declares retention truthfully', async () => {
  const f = await fixture();
  try {
    const artifact = await f.store.writeText({ taskId: 'first', kind: 'log', retention: 'log' }, 'Token fixture-private-credential\n', f.repository, actor);
    const bytes = await readFile(join(f.source, artifact.location));
    assert.equal(bytes.toString(), 'Token [REDACTED]\n'); assert.equal(sha256(bytes), artifact.sha256); assert.equal(bytes.length, artifact.bytes);
    assert.deepEqual(artifact.retention, { class: 'log', days: 30 }); assert.equal(artifact.redacted, true);
    const record = f.repository.artifacts('first')[0]; assert.deepEqual(await f.repository.verifyStoredArtifact(record.id), artifact);
    assert.equal(f.repository.events('first').at(-1)?.type, 'artifact.recorded'); assert.equal(f.repository.events('first').at(-1)?.actor, 'owner');
    assert.equal((await stat(join(f.source, artifact.location))).mode & 0o777, 0o600);
    assert.equal((await stat(join(f.source, 'artifacts'))).mode & 0o777, 0o700);
    const before = f.repository.events('first').length; await f.repository.recordArtifact(record, actor); assert.equal(f.repository.events('first').length, before);
    assert.ok(!inspect(f.store, { depth: 5 }).includes('fixture-private-credential'));
  } finally { await f.cleanup(); }
});
test('binary evidence preserves exact bytes without claiming redaction or automatic expiry', async () => {
  const f = await fixture();
  try {
    const bytes = Buffer.from([0, 255, 1, 2]); const artifact = await f.store.writeBinary({ taskId: 'first', kind: 'screenshot' }, bytes, f.repository, actor);
    assert.deepEqual(await readFile(join(f.source, artifact.location)), bytes); assert.equal(artifact.redacted, false); assert.equal(artifact.format, 'binary');
    assert.deepEqual(artifact.retention, { class: 'evidence', days: null }); assert.equal(artifactPolicy.preserveEvidence, true);
  } finally { await f.cleanup(); }
});
test('failed staging cleans temporary files; failed metadata transaction leaves an unreferenced artifact, never a dangling DB record', async () => {
  const f = await fixture(); const db = new DatabaseSync(f.filename);
  try {
    await assert.rejects(f.store.writeText({ taskId: 'first', kind: 'log' }, 'text', f.repository, actor, { async beforePublish() { throw new Error('Injected failure'); } }));
    assert.deepEqual(await readdir(join(f.source, 'artifacts')), []); assert.deepEqual(f.repository.artifacts(), []);
    db.exec("CREATE TRIGGER fail_artifact_event BEFORE INSERT ON ctx_events WHEN NEW.type='artifact.recorded' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;");
    await assert.rejects(f.store.writeText({ taskId: 'first', kind: 'log' }, 'text', f.repository, actor), code('INTERNAL'));
    assert.deepEqual(f.repository.artifacts(), []); assert.equal((await readdir(join(f.source, 'artifacts'))).length, 1);
    const snapshot = await createBackup(f.filename, join(f.root, 'backup')); assert.equal(snapshot.manifest.files.length, 1);
  } finally { db.close(); await f.cleanup(); }
});
test('artifact limits, data-root mismatches and traversal are rejected before metadata publication', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.store.writeText({ taskId: 'first', kind: 'log' }, 'a'.repeat(artifactPolicy.maxArtifactBytes + 1), f.repository, actor), code('BUDGET_EXHAUSTED'));
    const other = await ArtifactStore.open(join(f.root, 'other'));
    await assert.rejects(other.writeText({ taskId: 'first', kind: 'log' }, 'text', f.repository, actor), code('CONFLICT'));
    await assert.rejects(f.store.writeText({ taskId: '../escape', kind: 'log' }, 'text', f.repository, actor), code('INVALID_INPUT'));
    const artifact = await f.store.writeText({ taskId: 'first', kind: 'report' }, 'text', f.repository, actor);
    const { schemaVersion: _schema, format: _format, redacted: _redacted, retention: _retention, ...record } = artifact;
    await assert.rejects(f.repository.recordArtifact({ ...record, location: '../escape' }, actor), code('INVALID_INPUT'));
    await assert.rejects(f.repository.recordArtifact({ ...record, sha256: '0'.repeat(64) }, actor), code('CONFLICT'));
  } finally { await f.cleanup(); }
});
test('15 tasks and all referenced text/binary evidence restore to a new directory after source removal', async () => {
  const f = await fixture(); let closed = false;
  try {
    for (let i = 0; i < 14; i++) f.repository.submitTask(submissionFixture(repositoryTaskId(i), i ? [repositoryTaskId(i - 1)] : ['first']), actor);
    await f.store.writeText({ taskId: 'first', kind: 'patch' }, 'diff --git a/file b/file\n', f.repository, actor);
    await f.store.writeBinary({ taskId: 'first', kind: 'verification' }, Buffer.from([1, 0, 2, 255]), f.repository, actor);
    const tasks = f.repository.listTasks(); const events = f.repository.events(); const notifications = f.repository.pendingNotifications(); const artifacts = f.repository.artifacts();
    const created = await createBackup(f.filename, join(f.root, 'backup')); assert.equal(created.manifest.files.length, 5);
    f.repository.close(); closed = true; await rm(f.source, { recursive: true, force: true });
    const restored = await restoreBackup(created.directory, join(f.root, 'restore')); const repository = await TaskRepository.open(restored.database);
    try {
      assert.deepEqual(repository.listTasks(), tasks); assert.deepEqual(repository.events(), events); assert.deepEqual(repository.pendingNotifications(), notifications); assert.deepEqual(repository.artifacts(), artifacts);
      for (const artifact of artifacts) await repository.verifyStoredArtifact(artifact.id);
      const db = new DatabaseSync(restored.database, { readOnly: true }); try { assert.equal((db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok'); assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []); } finally { db.close(); }
    } finally { repository.close(); }
  } finally { if (!closed) f.repository.close(); await rm(f.root, { recursive: true, force: true }); }
});
for (const component of ['database', 'artifact', 'manifest'] as const) test(`tampered ${component} prevents restore publication`, async () => {
  const f = await fixture();
  try {
    await f.store.writeText({ taskId: 'first', kind: 'report' }, 'Evidence', f.repository, actor);
    const created = await createBackup(f.filename, join(f.root, 'backup')); const entry = created.manifest.files.find(file => file.kind === component)!;
    await writeFile(join(created.directory, 'snapshot', entry.path), 'tampered');
    await assert.rejects(restoreBackup(created.directory, join(f.root, 'restore')));
    await assert.rejects(stat(join(f.root, 'restore', 'data')), { code: 'ENOENT' });
    assert.equal(f.repository.listTasks().length, 1);
  } finally { await f.cleanup(); }
});
test('rewriting bundle checksums cannot detach artifact content from database and per-artifact hashes', async () => {
  const f = await fixture();
  try {
    await f.store.writeText({ taskId: 'first', kind: 'report' }, 'Original', f.repository, actor);
    const created = await createBackup(f.filename, join(f.root, 'backup')); const file = created.manifest.files.find(file => file.kind === 'artifact')!;
    await writeFile(join(created.directory, 'snapshot', file.path), 'Replaced'); file.sha256 = sha256('Replaced'); file.bytes = Buffer.byteLength('Replaced');
    await writeFile(join(created.directory, 'snapshot', 'manifest.json'), JSON.stringify(created.manifest));
    await assert.rejects(restoreBackup(created.directory, join(f.root, 'restore')), code('CONFLICT'));
    await assert.rejects(stat(join(f.root, 'restore', 'data')), { code: 'ENOENT' });
  } finally { await f.cleanup(); }
});
test('valid-looking manifest policy changes are rejected by the immutable audit hash', async () => {
  const f = await fixture();
  try {
    const artifact = await f.store.writeText({ taskId: 'first', kind: 'report' }, 'Evidence', f.repository, actor);
    const created = await createBackup(f.filename, join(f.root, 'backup'));
    const changed = { ...artifact, retention: { class: 'log', days: 30 } };
    const path = join('artifacts', artifact.id, 'manifest.json'); await writeFile(join(f.source, path), JSON.stringify(changed));
    await assert.rejects(f.repository.verifyStoredArtifact(artifact.id), code('CONFLICT'));
    await assert.rejects(createBackup(f.filename, join(f.root, 'source-tamper')), code('CONFLICT'));
    const bytes = JSON.stringify(changed); await writeFile(join(created.directory, 'snapshot', path), bytes);
    const entry = created.manifest.files.find(file => file.path === path)!; entry.sha256 = sha256(bytes); entry.bytes = Buffer.byteLength(bytes);
    await writeFile(join(created.directory, 'snapshot', 'manifest.json'), JSON.stringify(created.manifest));
    await assert.rejects(restoreBackup(created.directory, join(f.root, 'restore')), code('CONFLICT'));
  } finally { await f.cleanup(); }
});
test('symlink content and traversal manifests cannot read or overwrite files outside storage', async () => {
  const f = await fixture();
  try {
    const artifact = await f.store.writeText({ taskId: 'first', kind: 'report' }, 'Evidence', f.repository, actor);
    const external = join(f.root, 'human-file'); await writeFile(external, 'Human edits');
    const created = await createBackup(f.filename, join(f.root, 'backup'));
    const content = join(created.directory, 'snapshot', artifact.location); await rm(content); await symlink(external, content);
    await assert.rejects(restoreBackup(created.directory, join(f.root, 'restore-link')));
    created.manifest.files[0].path = '../human-file';
    await writeFile(join(created.directory, 'snapshot', 'manifest.json'), JSON.stringify(created.manifest));
    await assert.rejects(restoreBackup(created.directory, join(f.root, 'restore-path')), code('INVALID_INPUT'));
    assert.equal(await readFile(external, 'utf8'), 'Human edits');
    await rm(join(f.source, artifact.location)); await symlink(external, join(f.source, artifact.location));
    await assert.rejects(createBackup(f.filename, join(f.root, 'source-tamper')));
    await assert.rejects(stat(join(f.root, 'source-tamper', 'snapshot')), { code: 'ENOENT' });
  } finally { await f.cleanup(); }
});
test('backup refuses missing evidence, active leases, and existing destinations without clobbering user data', async () => {
  const f = await fixture(); const db = new DatabaseSync(f.filename);
  try {
    const artifact = await f.store.writeText({ taskId: 'first', kind: 'report' }, 'Evidence', f.repository, actor);
    await mkdir(join(f.root, 'occupied')); await writeFile(join(f.root, 'occupied', 'human'), 'Keep');
    await assert.rejects(createBackup(f.filename, join(f.root, 'occupied')), { code: 'EEXIST' });
    assert.equal(await readFile(join(f.root, 'occupied', 'human'), 'utf8'), 'Keep');
    const backup = await createBackup(f.filename, join(f.root, 'backup'));
    await assert.rejects(restoreBackup(backup.directory, join(f.root, 'occupied')), { code: 'EEXIST' });
    db.prepare('INSERT INTO ctx_attempts(id,task_id,sequence,task_revision,state,harness_id,provider_key,model_id,fencing_token,started_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run('attempt', 'first', 1, 1, 'running', 'codex', 'account/model', 'model', 1, new Date().toISOString());
    await assert.rejects(createBackup(f.filename, join(f.root, 'active')), code('CONFLICT'));
    db.exec("UPDATE ctx_attempts SET state='interrupted'"); await rm(join(f.source, artifact.location));
    await assert.rejects(createBackup(f.filename, join(f.root, 'missing')));
    await assert.rejects(stat(join(f.root, 'missing', 'snapshot')), { code: 'ENOENT' });
  } finally { db.close(); await f.cleanup(); }
});
test('legacy DB and evidence archive byte-for-byte; restored legacy runner is quarantined from stale worktrees', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ctx-legacy-backup-')); const source = join(root, 'source'); await mkdir(source); const directory = join(source, 'legacy'); await mkdir(directory);
  const filename = join(source, 'harness.sqlite'); const store = new TaskStore(filename); const now = new Date().toISOString();
  try {
    const task: TaskRecord = { id: 'legacy', request: 'Historical work', repositoryPath: source, directory, workspacePath: '/tmp/old-worktree', status: 'queued', createdAt: now, updatedAt: now, plan: { version: 1, steps: [] }, commands: {}, prepared: false, maxRepairAttempts: 0, remainingRepairAttempts: 0, attempts: [], verification: [], timeoutMs: 10000, elapsedMs: 0 };
    store.create(task); const owner = store.claim(task.id, 1000); const path = join(directory, 'report.log'); await writeFile(path, 'Historical evidence'); store.artifact(task.id, owner, path, sha256('Historical evidence'), 'log'); store.release(task.id, owner);
    const created = await createBackup(filename, join(root, 'backup')); const restored = await restoreBackup(created.directory, join(root, 'restore'));
    assert.equal(restored.legacyArchived, 1); assert.equal(await readFile(join(restored.directory, 'legacy', '0', 'content'), 'utf8'), 'Historical evidence');
    assert.throws(() => new TaskStore(restored.database), /archived for review/);
    const db = new DatabaseSync(restored.database, { readOnly: true }); try { assert.equal((db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok'); assert.deepEqual(JSON.parse((db.prepare('SELECT data FROM tasks').get() as { data: string }).data), task); } finally { db.close(); }
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
test('backup/restore CLI uses explicit source and new destinations, preserving task/evidence identity', async () => {
  const f = await fixture();
  try {
    await f.store.writeText({ taskId: 'first', kind: 'report' }, 'CLI evidence', f.repository, actor);
    const cli = resolve('dist/apps/cli/src/index.js'); const args = ['--disable-warning=ExperimentalWarning', cli];
    const backup = await execute(process.execPath, [...args, 'backup', join(f.root, 'backup'), '--database', f.filename]);
    assert.equal(JSON.parse(backup.stdout).directory, join(f.root, 'backup'));
    const restored = await execute(process.execPath, [...args, 'restore', join(f.root, 'backup'), '--output', join(f.root, 'restore')]);
    const result = JSON.parse(restored.stdout); const repository = await TaskRepository.open(result.database); try { assert.equal(repository.getTask('first').spec.id, 'first'); assert.equal(repository.artifacts().length, 1); } finally { repository.close(); }
    await assert.rejects(execute(process.execPath, [...args, 'backup', join(f.root, 'invalid')]));
  } finally { await f.cleanup(); }
});
test('SIGKILL during artifact staging cannot publish a DB reference or corrupt subsequent backup', { timeout: 20000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'ctx-artifact-crash-'));
  const child = fork(resolve('dist/tests/fixtures/artifact-worker.js'), [root], { execArgv: [], env: { ...process.env, NODE_TEST_CONTEXT: undefined }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }); const exited = once(child, 'exit');
  try {
    const [message] = await Promise.race([once(child, 'message'), exited.then(() => { throw new Error('Artifact fixture exited before staging boundary'); })]);
    assert.match((message as { directory: string }).directory, /\.staging-/); child.kill('SIGKILL'); await exited;
    const repository = await TaskRepository.open(join(root, 'state.sqlite'));
    try { assert.deepEqual(repository.artifacts(), []); assert.equal(repository.getTask('artifact-task').state, 'queued'); const created = await createBackup(join(root, 'state.sqlite'), join(root, 'backup')); assert.equal(created.manifest.files.length, 1); } finally { repository.close(); }
  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; } await rm(root, { recursive: true, force: true }); }
});
