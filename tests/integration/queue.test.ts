import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir, hostname } from 'node:os';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { TaskRepository } from '../../packages/persistence/src/task-repository.js';
import { ArtifactStore } from '../../packages/persistence/src/artifact-store.js';
import { FixtureWorker, fixtureReceiptPath } from '../../packages/core/src/fixture-worker.js';
import { DurableScheduler } from '../../packages/core/src/durable-scheduler.js';
import { queueActor as actor, queueSubmission } from '../fixtures/queue.js';
import { submissionFixture } from '../fixtures/repository.js';
import { CtxError } from '../../packages/shared/src/errors.js';
import { processIdentity } from '../../packages/persistence/src/process-identity.js';
import type { LeaseClaim, QueueWorker, WorkerOutcome } from '../../packages/shared/src/scheduling.js';
const code = (value: CtxError['code']) => (error: unknown) => error instanceof CtxError && error.code === value;
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ctx-queue-')); const project = join(root, 'project'); await mkdir(project);
  const filename = join(root, 'data', 'state.sqlite'); const repository = await TaskRepository.open(filename, {});
  await repository.registerProject({ id: 'fixture', repositoryPath: project, policyId: 'fixture-only', verificationProfile: 'fixture-v1' }, actor, 'Owner registered fixture-only project');
  return { root, filename, project, repository, async cleanup() { repository.close(); await rm(root, { recursive: true, force: true }); } };
}
function childWorker(filename: string, mode: string, owner = 'worker') {
  const child = fork(resolve('dist/tests/fixtures/queue-worker.js'), [filename, mode, owner], { execArgv: [], env: { ...process.env, NODE_TEST_CONTEXT: undefined }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let errors = ''; child.stderr?.on('data', chunk => { errors = (errors + chunk.toString()).slice(-5000); }); const exited = once(child, 'exit');
  const message = () => Promise.race([once(child, 'message').then(([value]) => value as unknown), exited.then(() => { throw new Error(`Queue fixture exited before boundary: ${errors}`); })]);
  return { child, exited, message, async stop() { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; } };
}
test('15-task DAG completes in deterministic order with independently verified fixture evidence', async () => {
  const f = await fixture(); const started: string[] = []; const scheduler = new DurableScheduler(f.repository, new FixtureWorker(f.repository.dataDirectory, {}, { started: claim => { started.push(claim.task.spec.id); } }));
  try {
    const ids = Array.from({ length: 15 }, (_, i) => `task-${String(i).padStart(2, '0')}`);
    for (let i = 0; i < ids.length; i++) f.repository.submitTask(queueSubmission(ids[i], i ? [ids[Math.floor((i - 1) / 2)]] : []), actor);
    const status = await scheduler.runUntilIdle(); assert.equal(status.completed, 15); assert.equal(status.running, 0); assert.equal(status.waiting, 0); assert.deepEqual(started, ids); assert.equal(scheduler.lastError, undefined);
    for (const task of f.repository.listTasks()) {
      assert.equal(task.state, 'completed'); assert.equal(f.repository.queue.attempts(task.spec.id).length, 1);
      assert.equal(f.repository.queue.attempts(task.spec.id)[0].harnessId, 'fixture');
      const artifacts = f.repository.artifacts(task.spec.id); assert.equal(artifacts.length, 2);
      for (const artifact of artifacts) await f.repository.verifyStoredArtifact(artifact.id);
      const completed = f.repository.events(task.spec.id).find(event => event.type === 'task.completed')!;
      for (const dep of task.spec.dependsOn) assert.ok(f.repository.events(dep).find(event => event.type === 'task.completed')!.sequence < f.repository.events(task.spec.id).find(event => event.type === 'task.running')!.sequence);
      assert.equal(completed.actor, 'scheduler'); assert.match(completed.reason, /Fixture-only/);
    }
    assert.deepEqual(await readdir(f.project), []);
  } finally { await scheduler.shutdown(); await f.cleanup(); }
});
test('priority selects urgent work first, independent of submission age', async () => {
  const f = await fixture(); const order: string[] = []; const scheduler = new DurableScheduler(f.repository, new FixtureWorker(f.repository.dataDirectory, {}, { started: claim => { order.push(claim.task.spec.id); } }));
  try {
    for (const [id, priority] of [['old-low', 'low'], ['normal', 'normal'], ['new-urgent', 'urgent'], ['high', 'high']] as const) { const input = queueSubmission(id); input.spec.priority = priority; f.repository.submitTask(input, actor); }
    await scheduler.runUntilIdle(); assert.deepEqual(order, ['new-urgent', 'high', 'normal', 'old-low']);
  } finally { await scheduler.shutdown(); await f.cleanup(); }
});
test('global and per-project slots are enforced while independent projects progress', async () => {
  const f = await fixture(); const other = join(f.root, 'other'); await mkdir(other); const order: string[] = []; let maximum = 0;
  await f.repository.registerProject({ id: 'other', repositoryPath: other, policyId: 'fixture-only', verificationProfile: 'fixture-v1' }, actor, 'Owner registered second fixture');
  f.repository.queue.configure({ maxWorkers: 2, maxWorkersPerProject: 1 }, actor);
  const worker = new FixtureWorker(f.repository.dataDirectory, Object.fromEntries(['a1', 'a2', 'b1', 'b2'].map(id => [id, [{ outcome: 'success' as const, sleepMs: 50 }]])), { started: claim => { order.push(claim.task.spec.id); maximum = Math.max(maximum, f.repository.queue.status().running); } });
  const scheduler = new DurableScheduler(f.repository, worker);
  try {
    for (const [id, project] of [['a1', 'fixture'], ['a2', 'fixture'], ['b1', 'other'], ['b2', 'other']]) f.repository.submitTask(queueSubmission(id, [], project), actor);
    assert.equal((await scheduler.runUntilIdle()).completed, 4); assert.equal(maximum, 2); assert.deepEqual(order.slice(0, 2), ['a1', 'b1']);
  } finally { await scheduler.shutdown(); await f.cleanup(); }
});
test('failed, cancelled and incomplete prerequisites never allow dependent worker starts', async () => {
  const f = await fixture(); const started: string[] = []; const scheduler = new DurableScheduler(f.repository, new FixtureWorker(f.repository.dataDirectory, { root: [{ outcome: 'failed' }] }, { started: claim => { started.push(claim.task.spec.id); } }));
  try {
    for (const input of [queueSubmission('root'), queueSubmission('child', ['root']), queueSubmission('grandchild', ['child'])]) f.repository.submitTask(input, actor);
    f.repository.queue.refresh(actor); assert.equal(f.repository.getTask('child').state, 'waiting_dependency'); assert.equal(f.repository.queue.claim({ ownerId: 'x', workerKind: 'opencode', leaseMs: 1000 }, actor), undefined);
    const status = await scheduler.runUntilIdle(); assert.equal(status.failed, 1); assert.equal(status.blocked, 2); assert.deepEqual(started, ['root']);
    const queued = f.repository.submitTask(queueSubmission('cancelled'), actor).task; f.repository.queue.controlTask('cancelled', 'cancel', queued.revision, actor, 'Owner cancelled before start'); f.repository.submitTask(queueSubmission('after-cancel', ['cancelled']), actor);
    await scheduler.runUntilIdle(); assert.equal(f.repository.getTask('after-cancel').state, 'blocked'); assert.deepEqual(started, ['root']);
  } finally { await scheduler.shutdown(); await f.cleanup(); }
});
test('independent fixture verification rejects false worker success and cannot complete ordinary projects', async () => {
  const f = await fixture(); const scheduler = new DurableScheduler(f.repository, new FixtureWorker(f.repository.dataDirectory, { bad: [{ outcome: 'success', corruptReceipt: true }] }));
  try {
    f.repository.submitTask(queueSubmission('bad'), actor); assert.equal((await scheduler.runUntilIdle()).failed, 1); assert.equal(f.repository.artifacts('bad').length, 0);
    const real = join(f.root, 'real'); await mkdir(real); await f.repository.registerProject({ id: 'real', repositoryPath: real, policyId: 'safe', verificationProfile: 'node-api' }, actor, 'Owner registered ordinary project');
    const input = submissionFixture('ordinary'); input.spec.projectId = 'real'; f.repository.submitTask(input, actor);
    const status = await scheduler.runUntilIdle(); assert.equal(status.ready, 1); assert.equal(f.repository.queue.attempts('ordinary').length, 0); assert.deepEqual(await readdir(real), []);
  } finally { await scheduler.shutdown(); await f.cleanup(); }
});
test('global pause persists across reopen and drains current work without starting another task', async () => {
  const f = await fixture(); const started: string[] = []; const scheduler = new DurableScheduler(f.repository, new FixtureWorker(f.repository.dataDirectory, { first: [{ outcome: 'success', sleepMs: 40 }] }, { started: claim => { started.push(claim.task.spec.id); } }));
  try {
    f.repository.submitTask(queueSubmission('first'), actor); f.repository.submitTask(queueSubmission('second'), actor);
    scheduler.tick(); f.repository.queue.pauseAll(true, actor); const paused = await scheduler.runUntilIdle(); assert.equal(paused.completed, 1); assert.deepEqual(started, ['first']);
    const reopened = await TaskRepository.open(f.filename); try { assert.equal(reopened.queue.status().configuration.paused, true); reopened.queue.pauseAll(false, actor); } finally { reopened.close(); }
    assert.equal((await scheduler.runUntilIdle()).completed, 2);
  } finally { await scheduler.shutdown(); await f.cleanup(); }
});
test('task pause drains a failed attempt and prevents retry until explicit revision-checked resume', async () => {
  const f = await fixture(); const scheduler = new DurableScheduler(f.repository, new FixtureWorker(f.repository.dataDirectory, { task: [{ outcome: 'failed', retryable: true, sleepMs: 40, retryDelayMs: 10 }, { outcome: 'success' }] }));
  try {
    f.repository.submitTask(queueSubmission('task'), actor); scheduler.tick(); const running = f.repository.getTask('task');
    f.repository.queue.controlTask('task', 'pause', running.revision, actor, 'Pause after this attempt');
    assert.equal((await scheduler.runUntilIdle()).paused, 1); assert.equal(f.repository.queue.attempts('task').length, 1);
    assert.throws(() => f.repository.queue.controlTask('task', 'resume', running.revision, actor, 'Stale resume'), code('CONFLICT'));
    f.repository.queue.controlTask('task', 'resume', f.repository.getTask('task').revision, actor, 'Owner resumed'); assert.equal((await scheduler.runUntilIdle({ waitForDeadlines: true })).completed, 1);
  } finally { await scheduler.shutdown(); await f.cleanup(); }
});
test('a global pause also stops worker invocation for an already-claimed but unstarted attempt', async () => {
  const f = await fixture();
  try {
    f.repository.submitTask(queueSubmission('task'), actor); f.repository.queue.refresh(actor);
    const claim = f.repository.queue.claim({ ownerId: 'owner', workerKind: 'fixture', leaseMs: 1000 }, actor)!;
    f.repository.queue.pauseAll(true, actor); assert.throws(() => f.repository.queue.start(claim, actor), code('CONFLICT'));
    assert.equal(f.repository.getTask('task').state, 'leased'); f.repository.queue.stopped(claim, actor, 'Unstarted claim is quiescent during pause');
    assert.equal(f.repository.queue.claim({ ownerId: 'owner', workerKind: 'fixture', leaseMs: 1000 }, actor), undefined);
    assert.equal(f.repository.queue.status().configuration.paused, true);
  } finally { await f.cleanup(); }
});
test('cancellation propagates an abort signal and becomes terminal only after worker quiescence', async () => {
  const f = await fixture(); let aborted = false; const underlying = new FixtureWorker(f.repository.dataDirectory, { task: [{ outcome: 'success', sleepMs: 5000 }] });
  const worker: QueueWorker = { kind: 'fixture', execute(input) { input.signal.addEventListener('abort', () => { aborted = true; }); return underlying.execute(input); } };
  const scheduler = new DurableScheduler(f.repository, worker, { leaseMs: 300 });
  try {
    f.repository.submitTask(queueSubmission('task'), actor); scheduler.tick(); const running = f.repository.getTask('task');
    f.repository.queue.controlTask('task', 'cancel', running.revision, actor, 'Owner cancellation'); assert.equal(f.repository.getTask('task').state, 'running');
    assert.equal((await scheduler.runUntilIdle()).cancelled, 1); assert.equal(aborted, true); assert.equal(f.repository.queue.attempts('task')[0].state, 'cancelled'); assert.equal(f.repository.artifacts('task').length, 0);
  } finally { await scheduler.shutdown(); await f.cleanup(); }
});
test('a worker ignoring abort retains its lease and slot until its promise actually settles', async () => {
  const f = await fixture(); let release!: (result: WorkerOutcome) => void; let signal!: AbortSignal;
  const worker: QueueWorker = { kind: 'fixture', execute(input) { signal = input.signal; return new Promise(resolveResult => { release = resolveResult; }); } };
  const scheduler = new DurableScheduler(f.repository, worker, { leaseMs: 300 });
  try {
    f.repository.submitTask(queueSubmission('first'), actor); f.repository.submitTask(queueSubmission('second'), actor); scheduler.tick();
    f.repository.queue.controlTask('first', 'cancel', f.repository.getTask('first').revision, actor, 'Cancel'); await delay(150);
    assert.equal(signal.aborted, true); assert.equal(f.repository.getTask('first').state, 'running'); assert.equal(f.repository.queue.status().running, 1);
    assert.equal(f.repository.queue.claim({ ownerId: 'other', workerKind: 'fixture', leaseMs: 1000 }, actor), undefined);
    const stopped = scheduler.shutdown(); release({ kind: 'success' }); await stopped; assert.equal(f.repository.getTask('first').state, 'cancelled');
  } finally { release?.({ kind: 'success' }); await scheduler.shutdown(); await f.cleanup(); }
});
test('an observation timeout leaves a live worker managed; shutdown confirms quiescence before retry', async () => {
  const f = await fixture(); const scheduler = new DurableScheduler(f.repository, new FixtureWorker(f.repository.dataDirectory, { task: [{ outcome: 'success', sleepMs: 5000 }] }), { leaseMs: 300 });
  try {
    f.repository.submitTask(queueSubmission('task'), actor); await assert.rejects(scheduler.runUntilIdle({ timeoutMs: 1 }), code('TIMEOUT'));
    assert.equal(scheduler.activeCount, 1); assert.equal(f.repository.getTask('task').state, 'running'); await scheduler.shutdown(); assert.equal(f.repository.getTask('task').state, 'recovering');
    const restarted = new DurableScheduler(f.repository, new FixtureWorker(f.repository.dataDirectory)); try { assert.equal((await restarted.runUntilIdle()).completed, 1); } finally { await restarted.shutdown(); }
  } finally { await scheduler.shutdown(); await f.cleanup(); }
});
test('capacity deadlines persist across reopen without an active worker or premature retry', async () => {
  const f = await fixture(); const scheduler = new DurableScheduler(f.repository, new FixtureWorker(f.repository.dataDirectory, { task: [{ outcome: 'capacity', retryDelayMs: 250 }, { outcome: 'success' }] }));
  try {
    f.repository.submitTask(queueSubmission('task'), actor); const waiting = await scheduler.runUntilIdle(); assert.equal(waiting.running, 0); assert.equal(waiting.waiting, 1); assert.ok(waiting.nextRunAt);
    const reopened = await TaskRepository.open(f.filename); try { reopened.queue.refresh(actor); assert.equal(reopened.getTask('task').nextRunAt, waiting.nextRunAt); assert.equal(reopened.getTask('task').state, 'waiting_capacity'); assert.equal(reopened.queue.claim({ ownerId: 'early', workerKind: 'fixture', leaseMs: 1000 }, actor), undefined); } finally { reopened.close(); }
    assert.equal((await scheduler.runUntilIdle({ waitForDeadlines: true })).completed, 1); assert.equal(f.repository.queue.attempts('task').length, 2);
  } finally { await scheduler.shutdown(); await f.cleanup(); }
});
test('automatic retries are bounded; explicit owner retry creates a new budget epoch and increasing fences', async () => {
  const f = await fixture(); const failing = new DurableScheduler(f.repository, new FixtureWorker(f.repository.dataDirectory, { task: [{ outcome: 'failed', retryable: true, retryDelayMs: 5 }] }));
  const success = new DurableScheduler(f.repository, new FixtureWorker(f.repository.dataDirectory));
  try {
    const input = queueSubmission('task'); input.spec.maxAttempts = 2; f.repository.submitTask(input, actor);
    assert.equal((await failing.runUntilIdle({ waitForDeadlines: true })).failed, 1); assert.equal(f.repository.queue.attempts('task').length, 2);
    f.repository.queue.controlTask('task', 'retry', f.repository.getTask('task').revision, actor, 'Owner explicitly authorized another bounded revision');
    assert.equal((await success.runUntilIdle()).completed, 1); assert.deepEqual(f.repository.queue.attempts('task').map(attempt => attempt.fencingToken), [1, 2, 3]);
    assert.throws(() => f.repository.queue.controlTask('task', 'retry', f.repository.getTask('task').revision, actor, 'Do not repeat completion'), code('CONFLICT'));
  } finally { await failing.shutdown(); await success.shutdown(); await f.cleanup(); }
});
test('approval fixture releases its worker and waits without granting authority; cancellation invalidates request', async () => {
  const f = await fixture(); const scheduler = new DurableScheduler(f.repository, new FixtureWorker(f.repository.dataDirectory, { task: [{ outcome: 'approval' }] }));
  try {
    f.repository.submitTask(queueSubmission('task'), actor); const status = await scheduler.runUntilIdle(); assert.equal(status.waiting, 1); assert.equal(status.running, 0); assert.equal(f.repository.getTask('task').state, 'waiting_approval');
    assert.throws(() => f.repository.queue.controlTask('task', 'resume', f.repository.getTask('task').revision, actor, 'Cannot approve through resume'), code('CONFLICT'));
    f.repository.queue.controlTask('task', 'cancel', f.repository.getTask('task').revision, actor, 'Reject work'); assert.equal(f.repository.getTask('task').state, 'cancelled');
    assert.ok(f.repository.events('task').some(event => event.type === 'approval.invalidated'));
  } finally { await scheduler.shutdown(); await f.cleanup(); }
});
test('expired leases are never stolen from a live owner; a fresh fence rejects old writes and artifacts', async () => {
  const f = await fixture(); const db = new DatabaseSync(f.filename);
  try {
    f.repository.submitTask(queueSubmission('task'), actor); f.repository.queue.refresh(actor); const old = f.repository.queue.claim({ ownerId: 'old', workerKind: 'fixture', leaseMs: 1000 }, actor)!;
    db.exec("UPDATE ctx_leases SET expires_at='2000-01-01T00:00:00.000Z'");
    assert.equal(f.repository.queue.reconcile(actor).alive, 1); assert.equal(f.repository.queue.claim({ ownerId: 'new', workerKind: 'fixture', leaseMs: 1000 }, actor), undefined); assert.throws(() => f.repository.queue.heartbeat(old, 1000), code('CONFLICT'));
    f.repository.queue.stopped(old, actor, 'Fixture owner confirms no worker was started'); f.repository.queue.refresh(actor);
    const fresh = f.repository.queue.claim({ ownerId: 'new', workerKind: 'fixture', leaseMs: 5000 }, actor)!; assert.ok(fresh.fencingToken > old.fencingToken);
    assert.throws(() => f.repository.queue.start(old, actor), code('CONFLICT')); assert.throws(() => f.repository.queue.stopped(old, actor, 'Late stale cleanup'), code('CONFLICT'));
    const store = await ArtifactStore.open(f.repository.dataDirectory); await assert.rejects(store.writeText({ taskId: 'task', attemptId: old.attempt.id, kind: 'late-event' }, 'Stale output', f.repository, actor), code('CONFLICT'));
    assert.equal(f.repository.artifacts().length, 0); assert.equal(f.repository.getTask('task').state, 'leased'); f.repository.queue.stopped(fresh, actor, 'Fixture cleanup');
  } finally { db.close(); await f.cleanup(); }
});
test('unknown/remote owner identity stays quarantined rather than assumed dead', async () => {
  const f = await fixture(); const db = new DatabaseSync(f.filename);
  try {
    f.repository.submitTask(queueSubmission('task'), actor); f.repository.queue.refresh(actor); const claim = f.repository.queue.claim({ ownerId: 'owner', workerKind: 'fixture', leaseMs: 1000 }, actor)!;
    db.exec("UPDATE ctx_leases SET owner_host='other-host',expires_at='2000-01-01T00:00:00.000Z'"); assert.equal(f.repository.queue.reconcile(actor).unknown, 1); assert.equal(f.repository.queue.status().running, 1);
    db.prepare('UPDATE ctx_leases SET owner_host=?').run(hostname());
    if (process.platform === 'linux') { db.prepare('UPDATE ctx_leases SET owner_start=?').run(`pid:[different-namespace]|${processIdentity().split('|')[1]}`); assert.equal(f.repository.queue.reconcile(actor).unknown, 1); db.prepare('UPDATE ctx_leases SET owner_start=?').run(processIdentity()); }
    f.repository.queue.stopped(claim, actor, 'Fixture cleanup after restoring known identity');
  } finally { db.close(); await f.cleanup(); }
});
test('failed claim audit rolls back state, attempt and lease together', async () => {
  const f = await fixture(); const db = new DatabaseSync(f.filename);
  try {
    f.repository.submitTask(queueSubmission('task'), actor); f.repository.queue.refresh(actor); const ready = f.repository.getTask('task'); const events = f.repository.events().length;
    db.exec("CREATE TRIGGER fail_claim BEFORE INSERT ON ctx_events WHEN NEW.type='attempt.claimed' BEGIN SELECT RAISE(ABORT,'fixture claim failure'); END;");
    assert.throws(() => f.repository.queue.claim({ ownerId: 'owner', workerKind: 'fixture', leaseMs: 1000 }, actor), code('INTERNAL'));
    assert.deepEqual(f.repository.getTask('task'), ready); assert.equal(f.repository.queue.attempts('task').length, 0); assert.equal((db.prepare('SELECT COUNT(*) AS n FROM ctx_leases').get() as { n: number }).n, 0); assert.equal(f.repository.events().length, events);
  } finally { db.close(); await f.cleanup(); }
});
test('claim rechecks repository identity after readiness; interactive requests cannot be forced through a ready flag', async () => {
  const f = await fixture();
  try {
    const input = queueSubmission('interactive'); input.spec.mode = 'interactive'; f.repository.submitTask(input, actor); f.repository.transitionTask('interactive', 'ready', 1, actor, 'Administrative readiness cannot authorize delegation');
    assert.equal(f.repository.queue.claim({ ownerId: 'owner', workerKind: 'fixture', leaseMs: 1000 }, actor), undefined); assert.equal(f.repository.getTask('interactive').state, 'blocked');
    f.repository.submitTask(queueSubmission('task'), actor); f.repository.queue.refresh(actor); const elsewhere = join(f.root, 'elsewhere'); await mkdir(elsewhere); await rm(f.project, { recursive: true }); await symlink(elsewhere, f.project);
    assert.equal(f.repository.queue.claim({ ownerId: 'owner', workerKind: 'fixture', leaseMs: 1000 }, actor), undefined); assert.equal(f.repository.getTask('task').state, 'blocked'); assert.equal(f.repository.queue.attempts('task').length, 0);
  } finally { await f.cleanup(); }
});
for (const boundary of ['before-output', 'after-receipt'] as const) test(`scheduler SIGKILL recovery ${boundary} preserves 15 tasks without duplicate visible fixture effects`, { timeout: 20000 }, async () => {
  const f = await fixture(); const ids = Array.from({ length: 15 }, (_, i) => `task-${String(i).padStart(2, '0')}`);
  for (let i = 0; i < ids.length; i++) f.repository.submitTask(queueSubmission(ids[i], i ? [ids[i - 1]] : []), actor);
  const child = childWorker(f.filename, boundary); const scheduler = new DurableScheduler(f.repository, new FixtureWorker(f.repository.dataDirectory), { leaseMs: 1000 });
  try {
    const message = await child.message() as { claim: LeaseClaim; receipt?: { executionId: string } }; assert.equal(f.repository.getTask(ids[0]).state, 'running');
    scheduler.tick(); assert.equal(scheduler.activeCount, 0); await child.stop(); await delay(350);
    assert.equal((await scheduler.runUntilIdle()).completed, 15); assert.equal(f.repository.listTasks().length, 15);
    const attempts = f.repository.queue.attempts(ids[0]); assert.deepEqual(attempts.map(attempt => attempt.state), ['interrupted', 'completed']);
    if (message.receipt) { const result = f.repository.artifacts(ids[0]).find(artifact => artifact.kind === 'fixture-result')!; const content = JSON.parse(await (await import('node:fs/promises')).readFile(join(f.repository.dataDirectory, result.location), 'utf8')); assert.equal(content.executionId, message.receipt.executionId); }
    assert.equal((await readdir(join(f.repository.dataDirectory, 'fixture-work'))).filter(name => name.endsWith('.json')).length, 15);
  } finally { await child.stop(); await scheduler.shutdown(); await f.cleanup(); }
});
test('four processes concurrently submit and claim under the global two-slot limit; dead claims recover safely', { timeout: 20000 }, async () => {
  const f = await fixture(); f.repository.queue.configure({ maxWorkers: 2, maxWorkersPerProject: 2 }, actor);
  const children = Array.from({ length: 4 }, (_, i) => childWorker(f.filename, 'stress', `worker-${i}`)); const scheduler = new DurableScheduler(f.repository, new FixtureWorker(f.repository.dataDirectory));
  try {
    await Promise.all(children.map(child => child.message())); const messages = children.map(child => child.message()); for (const child of children) child.child.send('go');
    const results = await Promise.all(messages) as { claims: LeaseClaim[] }[]; const claims = results.flatMap(result => result.claims);
    assert.equal(claims.length, 2); assert.equal(new Set(claims.map(claim => claim.task.spec.id)).size, 2); assert.equal(f.repository.listTasks().length, 16); assert.equal(f.repository.queue.status().running, 2);
    await Promise.all(children.map(child => child.stop())); await delay(550); assert.equal((await scheduler.runUntilIdle()).completed, 16);
    assert.equal(f.repository.queue.status().running, 0); for (const task of f.repository.listTasks()) assert.equal(f.repository.queue.attempts(task.spec.id).filter(attempt => attempt.state === 'completed').length, 1);
  } finally { await Promise.all(children.map(child => child.stop())); await scheduler.shutdown(); await f.cleanup(); }
});
