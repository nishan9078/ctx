import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { inspect } from 'node:util';
import { TaskRepository } from '../../packages/persistence/src/task-repository.js';
import { CtxError } from '../../packages/shared/src/errors.js';
import type { SubmissionResult } from '../../packages/shared/src/repository.js';
import type { TaskSnapshot, Notification } from '../../packages/shared/src/domain.js';
import { repositoryActor as actor, repositoryTaskId, submissionFixture } from '../fixtures/repository.js';

const hasCode = (code: CtxError['code']) => (error: unknown): boolean => error instanceof CtxError && error.code === code;
async function fixture(env: NodeJS.ProcessEnv = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ctx-repository-')); const filename = join(root, 'state.sqlite');
  const repository = await TaskRepository.open(filename, env);
  await repository.registerProject({ id: 'fixture', repositoryPath: root, policyId: 'safe', verificationProfile: 'node-api' }, actor, 'Owner registered fixture');
  return { root, filename, repository, async cleanup() { repository.close(); await rm(root, { recursive: true, force: true }); } };
}
function counts(db: DatabaseSync): Record<string, number> {
  return Object.fromEntries(['tasks', 'task_dependencies', 'events', 'inbox', 'outbox'].map(table => [table, (db.prepare(`SELECT COUNT(*) AS n FROM ctx_${table}`).get() as { n: number }).n]));
}
test('project registration canonicalizes directories, is idempotent and never overwrites path/policy identity', async () => {
  const f = await fixture();
  try {
    const alias = join(f.root, 'alias'); await symlink(f.root, alias);
    const existing = f.repository.getProject('fixture'); const events = f.repository.events().length;
    const { createdAt: _createdAt, ...registration } = existing;
    assert.deepEqual(await f.repository.registerProject({ ...registration, repositoryPath: alias }, actor, 'Duplicate'), existing);
    assert.equal(f.repository.events().length, events);
  } finally { await f.cleanup(); }
});
test('invalid registration is rejected without an event or implicit project creation', async () => {
  const f = await fixture();
  try {
    const events = f.repository.events().length;
    for (const input of [
      { id: 'other', repositoryPath: f.root, policyId: 'safe', verificationProfile: 'node-api' },
      { id: 'fixture', repositoryPath: f.root, policyId: 'changed', verificationProfile: 'node-api' },
    ]) await assert.rejects(f.repository.registerProject(input, actor, 'Owner request'), hasCode('CONFLICT'));
    await assert.rejects(f.repository.registerProject({ id: 'other', repositoryPath: '../relative', policyId: 'safe', verificationProfile: 'node-api' }, actor, 'Owner request'), hasCode('INVALID_INPUT'));
    await assert.rejects(f.repository.registerProject({ id: 'other', repositoryPath: join(f.root, 'missing'), policyId: 'safe', verificationProfile: 'node-api' }, actor, 'Owner request'), hasCode('ENVIRONMENT_UNAVAILABLE'));
    assert.equal(f.repository.events().length, events); assert.throws(() => f.repository.getProject('other'), hasCode('NOT_FOUND'));
  } finally { await f.cleanup(); }
});
test('submission commits task, dependencies, inbox, audit and acknowledgement together', async () => {
  const f = await fixture(); const db = new DatabaseSync(f.filename);
  try {
    const before = structuredClone(submissionFixture('first'));
    const result = f.repository.submitTask(before, actor);
    assert.equal(result.duplicate, false); assert.equal(result.task.state, 'queued'); assert.equal(result.task.revision, 1); assert.deepEqual(result.task.spec, before.spec);
    f.repository.submitTask(submissionFixture('second', ['first']), actor);
    assert.deepEqual(counts(db), { tasks: 2, task_dependencies: 1, events: 3, inbox: 2, outbox: 2 });
    assert.equal(f.repository.events('first')[0].actor, 'owner'); assert.match(f.repository.events('first')[0].createdAt, /^\d{4}-\d\d-\d\dT/);
    assert.ok(f.repository.events('first')[0].reason); assert.equal(f.repository.pendingNotifications().length, 2);
    assert.deepEqual(f.repository.getNotification(result.acknowledgement.id), result.acknowledgement);
    assert.deepEqual(f.repository.listTasks(1).map(task => task.spec.id), ['first']); assert.deepEqual(f.repository.listTasks(1, 'first').map(task => task.spec.id), ['second']);
    assert.deepEqual(before, submissionFixture('first'));
  } finally { db.close(); await f.cleanup(); }
});
test('replay returns the original acknowledgement; changed payload, actor or routing cannot reuse its key', async () => {
  const f = await fixture(); const db = new DatabaseSync(f.filename);
  try {
    const input = submissionFixture('first'); const first = f.repository.submitTask(input, actor); const baseline = counts(db);
    const replay = f.repository.submitTask(input, { ...actor, requestId: 'transport-retry' });
    assert.equal(replay.duplicate, true); assert.deepEqual(replay.acknowledgement, first.acknowledgement); assert.deepEqual(counts(db), baseline);
    for (const changed of [{ ...input, spec: { ...input.spec, title: 'Changed' } }, { ...input, destination: { kind: 'discord' as const, address: 'other' } }, { ...input, spec: { ...input.spec, id: 'different' } }]) assert.throws(() => f.repository.submitTask(changed, actor), hasCode('CONFLICT'));
    assert.throws(() => f.repository.submitTask(input, { ...actor, actorId: 'different-owner' }), hasCode('CONFLICT'));
    assert.throws(() => f.repository.submitTask({ ...input, deduplicationKey: 'other-event' }, actor), hasCode('CONFLICT'));
    assert.deepEqual(counts(db), baseline);
    const local = submissionFixture('local-source'); local.spec.metadata.source = 'local'; local.deduplicationKey = input.deduplicationKey;
    assert.equal(f.repository.submitTask(local, { ...actor, source: 'local' }).duplicate, false);
  } finally { db.close(); await f.cleanup(); }
});
for (const boundary of ['outbox', 'inbox'] as const) test(`${boundary} failure rolls back task, dependencies, audit and acknowledgement; retry is safe`, async () => {
  const f = await fixture(); const db = new DatabaseSync(f.filename);
  try {
    f.repository.submitTask(submissionFixture('prerequisite'), actor); const baseline = counts(db);
    db.exec(`CREATE TRIGGER fail_ack BEFORE INSERT ON ctx_${boundary} WHEN NEW.task_id='child' BEGIN SELECT RAISE(ABORT, 'fixture failure after task/event insertion'); END;`);
    const input = submissionFixture('child', ['prerequisite']);
    assert.throws(() => f.repository.submitTask(input, actor), hasCode('INTERNAL'));
    assert.deepEqual(counts(db), baseline); assert.throws(() => f.repository.getTask('child'), hasCode('NOT_FOUND')); assert.deepEqual(f.repository.events('child'), []);
    db.exec('DROP TRIGGER fail_ack');
    assert.equal(f.repository.submitTask(input, actor).duplicate, false); assert.equal(f.repository.getTask('child').spec.dependsOn[0], 'prerequisite');
  } finally { db.close(); await f.cleanup(); }
});
test('unknown project, mismatched profile, missing dependency and forged input do not create partial records', async () => {
  const f = await fixture(); const db = new DatabaseSync(f.filename);
  try {
    const baseline = counts(db); const input = submissionFixture('first');
    for (const changed of [
      { ...input, spec: { ...input.spec, projectId: 'missing' } }, { ...input, spec: { ...input.spec, verificationProfile: 'skip-all' } },
      submissionFixture('first', ['missing']), { ...input, spec: { ...input.spec, acceptance: [] } }, { ...input, spec: { ...input.spec, permissions: ['admin'] } },
      { ...input, spec: { ...input.spec, metadata: { source: 'discord' } } },
    ]) assert.throws(() => f.repository.submitTask(changed, actor), CtxError);
    assert.deepEqual(counts(db), baseline);
  } finally { db.close(); await f.cleanup(); }
});
test('dependency edits detect transitive cycles and keep stored specification and edges consistent', async () => {
  const f = await fixture();
  try {
    for (const input of [submissionFixture('a'), submissionFixture('b', ['a']), submissionFixture('c', ['b'])]) f.repository.submitTask(input, actor);
    const a = f.repository.getTask('a'); const events = f.repository.events().length;
    assert.throws(() => f.repository.replaceDependencies('a', ['c'], 1, actor, 'Owner edit'), hasCode('CONFLICT'));
    assert.deepEqual(f.repository.getTask('a'), a); assert.equal(f.repository.events().length, events);
    assert.throws(() => f.repository.replaceDependencies('a', ['a'], 1, actor, 'Owner edit'), CtxError);
    assert.throws(() => f.repository.replaceDependencies('a', ['missing'], 1, actor, 'Owner edit'), hasCode('NOT_FOUND'));
    const updated = f.repository.replaceDependencies('c', ['a'], 1, actor, 'Owner changed prerequisite');
    assert.deepEqual(updated.spec.dependsOn, ['a']); assert.equal(updated.revision, 2);
    assert.throws(() => f.repository.replaceDependencies('c', [], 1, actor, 'Stale owner edit'), hasCode('CONFLICT'));
    assert.equal(f.repository.events('c').at(-1)?.type, 'task.dependencies_changed');
    f.repository.transitionTask('a', 'ready', 1, actor, 'Eligible');
    assert.throws(() => f.repository.replaceDependencies('a', ['b'], 2, actor, 'Too late'), hasCode('CONFLICT'));
  } finally { await f.cleanup(); }
});
test('two connections cannot overwrite stale task revisions; transitions have actor, reason and revision evidence', async () => {
  const f = await fixture(); const second = await TaskRepository.open(f.filename, {});
  try {
    f.repository.submitTask(submissionFixture('first'), actor); const stale = second.getTask('first');
    const paused = f.repository.transitionTask('first', 'paused', 1, actor, 'Owner paused'); assert.equal(paused.revision, 2);
    assert.throws(() => second.transitionTask('first', 'cancelled', stale.revision, actor, 'Stale cancel'), hasCode('CONFLICT'));
    assert.deepEqual(second.getTask('first'), paused);
    const resumed = second.transitionTask('first', 'queued', 2, actor, 'Owner resumed'); assert.equal(resumed.revision, 3);
    assert.deepEqual(f.repository.events('first').map(event => event.type), ['task.queued', 'task.paused', 'task.queued']);
    for (const event of f.repository.events('first')) { assert.equal(event.actor, 'owner'); assert.ok(event.reason); assert.ok(event.createdAt); }
    assert.deepEqual(f.repository.events('first', f.repository.events('first')[0].sequence, 1).map(event => event.type), ['task.paused']);
    assert.throws(() => second.transitionTask('first', 'completed', 3, actor, 'Agent said done'), hasCode('INVALID_TRANSITION'));
  } finally { second.close(); await f.cleanup(); }
});
test('audit failure rolls back a state/revision update', async () => {
  const f = await fixture(); const db = new DatabaseSync(f.filename);
  try {
    const original = f.repository.submitTask(submissionFixture('first'), actor).task; const baseline = counts(db);
    db.exec("CREATE TRIGGER fail_transition BEFORE INSERT ON ctx_events WHEN NEW.type='task.paused' BEGIN SELECT RAISE(ABORT, 'fixture event failure'); END;");
    assert.throws(() => f.repository.transitionTask('first', 'paused', 1, actor, 'Pause'), hasCode('INTERNAL'));
    assert.deepEqual(f.repository.getTask('first'), original); assert.deepEqual(counts(db), baseline);
    f.repository.submitTask(submissionFixture('other'), actor); const beforeEdit = counts(db);
    db.exec("CREATE TRIGGER fail_dependency_event BEFORE INSERT ON ctx_events WHEN NEW.type='task.dependencies_changed' BEGIN SELECT RAISE(ABORT, 'fixture event failure'); END;");
    assert.throws(() => f.repository.replaceDependencies('first', ['other'], 1, actor, 'Change dependency'), hasCode('INTERNAL'));
    assert.deepEqual(f.repository.getTask('first'), original); assert.deepEqual(counts(db), beforeEdit);
  } finally { db.close(); await f.cleanup(); }
});
test('eligibility and lifecycle guards refuse premature readiness, active work edits and approval bypass', async () => {
  const f = await fixture(); const db = new DatabaseSync(f.filename);
  try {
    f.repository.submitTask(submissionFixture('a'), actor); f.repository.submitTask(submissionFixture('b', ['a']), actor);
    assert.throws(() => f.repository.transitionTask('b', 'ready', 1, actor, 'Premature'), hasCode('CONFLICT'));
    f.repository.transitionTask('a', 'ready', 1, actor, 'Eligible');
    assert.throws(() => f.repository.transitionTask('a', 'leased', 2, actor, 'Must use claim'), hasCode('CONFLICT'));
    db.prepare('INSERT INTO ctx_approvals(id,task_id,task_revision,action,action_hash,requested_by,expires_at,decision) VALUES(?,?,?,?,?,?,?,?)').run('approval', 'a', 2, 'external_write', 'a'.repeat(64), 'owner', new Date(Date.now() + 60000).toISOString(), 'pending');
    assert.throws(() => f.repository.transitionTask('a', 'paused', 2, actor, 'Pending approval'), hasCode('CONFLICT'));
    db.prepare('INSERT INTO ctx_attempts(id,task_id,sequence,task_revision,state,harness_id,provider_key,model_id,fencing_token,started_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run('attempt', 'b', 1, 1, 'running', 'codex', 'account/model', 'model', 1, new Date().toISOString());
    assert.throws(() => f.repository.replaceDependencies('b', [], 1, actor, 'Cannot edit active work'), hasCode('CONFLICT'));
  } finally { db.close(); await f.cleanup(); }
});
test('known credentials are redacted from stored specifications, acknowledgements and audit reasons', async () => {
  const secret = 'private-"quoted"-credential'; const f = await fixture({ SERVICE_TOKEN: secret }); const db = new DatabaseSync(f.filename);
  try {
    const input = submissionFixture('first'); input.spec.objective = `Never expose ${secret}`; input.spec.title = `Task with ${secret}`;
    const result = f.repository.submitTask(input, actor);
    f.repository.transitionTask('first', 'paused', 1, actor, `Redact ${secret}`);
    const stored = JSON.stringify({ tasks: db.prepare('SELECT spec_json FROM ctx_tasks').all(), outbox: db.prepare('SELECT payload FROM ctx_outbox').all(), events: db.prepare('SELECT * FROM ctx_events').all() });
    assert.ok(!stored.includes(secret)); assert.ok(!stored.includes('quoted')); assert.match(stored, /REDACTED/); assert.match(result.acknowledgement.message, /REDACTED/);
    assert.equal(input.spec.objective, `Never expose ${secret}`);
    assert.ok(!inspect(f.repository, { depth: 5 }).includes(secret));
    assert.ok(!JSON.stringify(f.repository).includes(secret));
    assert.throws(() => f.repository.submitTask(submissionFixture('other'), { ...actor, actorId: secret }), hasCode('INVALID_INPUT'));
  } finally { db.close(); await f.cleanup(); }
});
test('notification queries use durable delivery metadata and reject inconsistent payload identity', async () => {
  const f = await fixture(); const db = new DatabaseSync(f.filename);
  try {
    const result = f.repository.submitTask(submissionFixture('first'), actor); const id = result.acknowledgement.id; const now = new Date().toISOString();
    db.prepare('UPDATE ctx_outbox SET retry_count=2,next_attempt_at=?,delivered_at=?,remote_message_id=? WHERE id=?').run(now, now, 'remote', id);
    assert.deepEqual(f.repository.pendingNotifications(), []); assert.equal(f.repository.getNotification(id).retryCount, 2); assert.equal(f.repository.getNotification(id).remoteMessageId, 'remote'); assert.equal(f.repository.getNotification(id).deliveredAt, now);
    db.prepare("UPDATE ctx_outbox SET payload=json_set(payload,'$.taskId','forged') WHERE id=?").run(id);
    assert.throws(() => f.repository.getNotification(id), hasCode('CONFLICT'));
  } finally { db.close(); await f.cleanup(); }
});

function worker(filename: string, root: string, mode: 'batch' | 'single') {
  const child = fork(resolve('dist/tests/fixtures/repository-worker.js'), [filename, root, mode], { execArgv: [], env: { ...process.env, NODE_TEST_CONTEXT: undefined }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let errors = ''; child.stderr?.on('data', data => { errors = (errors + data.toString()).slice(-5000); });
  const exited = once(child, 'exit');
  const message = Promise.race([once(child, 'message').then(([value]) => value as unknown), exited.then(() => { throw new Error(`Fixture exited before acknowledgement: ${errors}`); })]);
  return { child, exited, message };
}
test('15 acknowledged task identities, states, dependencies, events and notifications survive SIGKILL/reopen', { timeout: 20000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'ctx-repository-crash-')); const filename = join(root, 'state.sqlite'); const process = worker(filename, root, 'batch');
  try {
    const acknowledged = await process.message as { tasks: TaskSnapshot[]; notifications: Notification[]; events: unknown[] };
    assert.equal(acknowledged.tasks.length, 15); process.child.kill('SIGKILL'); const [, signal] = await process.exited; assert.equal(signal, 'SIGKILL');
    const repository = await TaskRepository.open(filename);
    try {
      assert.deepEqual(repository.listTasks(), acknowledged.tasks); assert.deepEqual(repository.pendingNotifications(), acknowledged.notifications); assert.deepEqual(repository.events(), acknowledged.events);
      const last = repositoryTaskId(14); const replay = repository.submitTask(submissionFixture(last, [repositoryTaskId(13)]), actor);
      assert.equal(replay.duplicate, true); assert.equal(repository.listTasks().length, 15); assert.equal(repository.pendingNotifications().length, 15);
      const db = new DatabaseSync(filename); try { assert.equal((db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok'); assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []); } finally { db.close(); }
    } finally { repository.close(); }
  } finally {
    if (process.child.exitCode === null && process.child.signalCode === null) { process.child.kill('SIGKILL'); await process.exited; }
    await rm(root, { recursive: true, force: true });
  }
});
test('simultaneous duplicate submissions from two processes create one task and one acknowledgement', { timeout: 20000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'ctx-repository-concurrent-')); const filename = join(root, 'state.sqlite');
  const initial = await TaskRepository.open(filename); initial.close(); const workers = [worker(filename, root, 'single'), worker(filename, root, 'single')];
  try {
    const results = await Promise.all(workers.map(async process => { const message = await process.message as SubmissionResult; const [code] = await process.exited; assert.equal(code, 0); return message; }));
    assert.deepEqual(results.map(result => result.duplicate).sort(), [false, true]); assert.equal(results[0].acknowledgement.id, results[1].acknowledgement.id);
    const repository = await TaskRepository.open(filename); try { assert.equal(repository.listTasks().length, 1); assert.equal(repository.pendingNotifications().length, 1); assert.equal(repository.events('single').length, 1); } finally { repository.close(); }
  } finally { for (const process of workers) if (process.child.exitCode === null && process.child.signalCode === null) { process.child.kill('SIGKILL'); await process.exited; } await rm(root, { recursive: true, force: true }); }
});
