import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createCodexQueueScheduler } from '../../packages/core/src/codex-queue-worker.js';
import { SupervisedCodexExecutor, liveProcessGroup } from '../../packages/core/src/supervised-codex-executor.js';
import { codexFixture } from '../fixtures/codex.js';
import { fakeCodex } from '../fixtures/fake-codex.js';
import { repositoryActor as actor } from '../fixtures/repository.js';
const probe = async () => ({ sdkVersion: '0.166.0', cliVersion: 'codex-cli fixture', cliAvailable: true, auth: 'auth-file' as const, model: 'unknown' as const, provider: 'unknown' as const, probeErrors: [] });
async function readArtifact(f: Awaited<ReturnType<typeof codexFixture>>, kind: string) {
  const artifact = f.repository.artifacts('task').find(a => a.kind === kind)!; assert.ok(artifact, kind);
  await f.repository.verifyStoredArtifact(artifact.id); return readFile(join(f.repository.dataDirectory, artifact.location), 'utf8');
}
test('durable queue runs installed SDK in owned host, preserves diff/events and blocks unverified completion', async () => {
  const f = await codexFixture(); const path = await fakeCodex(f.root);
  await writeFile(join(f.project, 'human.txt'), 'uncommitted source edit');
  const scheduler = createCodexQueueScheduler(f.repository, { probe, executor: new SupervisedCodexExecutor({ codexPathOverride: path }) });
  try {
    assert.equal((await scheduler.runUntilIdle()).blocked, 1); assert.equal(scheduler.lastError, undefined);
    const attempt = f.repository.queue.attempts('task')[0]; assert.equal(attempt.state, 'completed');
    assert.equal(f.repository.queue.session(attempt.id)?.externalSessionId, 'fixture-thread');
    assert.match(await readArtifact(f, 'codex-diff'), /fixture change/);
    assert.equal(await readFile(join(f.project, 'human.txt'), 'utf8'), 'uncommitted source edit');
    await assert.rejects(readFile(join(f.project, 'result.txt')), { code: 'ENOENT' });
    const events = f.repository.queue.workerEvents(attempt.id);
    assert.ok(events.some(e => e.type === 'started')); assert.ok(events.some(e => e.type === 'completed'));
    assert.ok(events.some(e => e.type === 'fixture.future')); assert.ok(events.some(e => e.type === 'command_executed'));
    events.forEach((event, index) => { assert.equal(event.sequence, index + 1); if (event.kind === 'canonical') assert.equal((event.payload as { sequence: number }).sequence, event.sequence); });
    const result = JSON.parse(await readArtifact(f, 'codex-result')); assert.equal(result.usage.inputTokens, 12); assert.equal(result.usage.outputTokens, 3); assert.equal(result.usage.costUsd, undefined);
    assert.deepEqual(liveProcessGroup(f.repository.queue.workerProcess(attempt.id)!.pgid), []);
    const descriptor = await readArtifact(f, 'codex-workspace'); const workspace = JSON.parse(descriptor).workspace;
    assert.equal(await readFile(join(workspace, 'human.txt'), 'utf8'), 'uncommitted source edit');
    // Explicit resume uses the same recorded thread/worktree in a new fenced attempt.
    const task = f.repository.getTask('task'); f.repository.queue.controlTask('task', 'retry', task.revision, actor, 'Explicit fixture resume');
    const resumed = createCodexQueueScheduler(f.repository, { probe, resume: { taskId: 'task', attemptId: attempt.id }, executor: new SupervisedCodexExecutor({ codexPathOverride: path }) });
    try { assert.equal((await resumed.runUntilIdle()).blocked, 1); assert.equal(resumed.lastError, undefined); assert.equal(f.repository.queue.attempts('task').length, 2); } finally { await resumed.shutdown(); }
  } finally { await scheduler.shutdown(); await f.cleanup(); }
});
for (const mode of ['truncated', 'killed', 'auth', 'rate'] as const) test(`queue records ${mode} without completing task`, async () => {
  const f = await codexFixture(); const path = await fakeCodex(f.root);
  const scheduler = createCodexQueueScheduler(f.repository, { probe, executor: new SupervisedCodexExecutor({ codexPathOverride: path, env: { ...process.env, CTX_SDK_FIXTURE: mode } }) });
  try {
    const status = await scheduler.runUntilIdle(); assert.equal(status.completed, 0); assert.equal(status.running, 0);
    const attempt = f.repository.queue.attempts('task')[0]; assert.notEqual(f.repository.getTask('task').state, 'completed');
    assert.ok(f.repository.queue.workerEvents(attempt.id).some(e => e.type === 'failed'));
    if (mode === 'rate') assert.equal(f.repository.getTask('task').state, 'waiting_capacity');
    else assert.equal(f.repository.getTask('task').state, 'blocked');
    if (mode === 'truncated' || mode === 'killed') assert.match(await readArtifact(f, 'codex-diff'), /fixture change/);
  } finally { await scheduler.shutdown(); await f.cleanup(); }
});
test('missing credentials block before any process is spawned', async () => {
  const f = await codexFixture(); let spawned = false;
  const scheduler = createCodexQueueScheduler(f.repository, { probe: async () => ({ ...await probe(), auth: 'none' }), executor: { async run() { spawned = true; throw new Error('unexpected launch'); } } });
  try { assert.equal((await scheduler.runUntilIdle()).blocked, 1); assert.equal(spawned, false); } finally { await scheduler.shutdown(); await f.cleanup(); }
});

test('queue cancellation waits for the real SDK process group to stop', { timeout: 15000 }, async () => {
  const f = await codexFixture(); const path = await fakeCodex(f.root);
  const supervisor = new SupervisedCodexExecutor({ codexPathOverride: path, graceMs: 50, env: { ...process.env, CTX_SDK_FIXTURE: 'hang' } });
  let cancelled = false;
  const scheduler = createCodexQueueScheduler(f.repository, { probe, leaseMs: 1000, executor: { run: input => supervisor.run({ ...input, async onRawEvent(raw) {
    await input.onRawEvent(raw);
    if ((raw as { type?: string }).type === 'item.completed') {
      const task = f.repository.getTask('task'); f.repository.queue.controlTask('task', 'cancel', task.revision, actor, 'Owner cancelled live SDK fixture'); cancelled = true;
    }
  } }) } });
  try {
    const status = await scheduler.runUntilIdle(); assert.equal(cancelled, true); assert.equal(status.cancelled, 1); assert.equal(status.running, 0);
    const attempt = f.repository.queue.attempts('task')[0]; assert.equal(attempt.state, 'cancelled');
    assert.deepEqual(liveProcessGroup(f.repository.queue.workerProcess(attempt.id)!.pgid), []);
    assert.ok(f.repository.queue.workerEvents(attempt.id).some(event => event.type === 'interrupted'));
  } finally { await scheduler.shutdown(); await f.cleanup(); }
});

test('transient resource exhaustion before launch persists a bounded retry deadline', async () => {
  const f = await codexFixture();
  const scheduler = createCodexQueueScheduler(f.repository, { probe, executor: { async run() { throw Object.assign(new Error('Process table temporarily unavailable'), { code: 'EAGAIN' }); } } });
  try {
    const status = await scheduler.runUntilIdle(); assert.equal(status.running, 0); assert.equal(status.completed, 0);
    assert.equal(f.repository.getTask('task').state, 'recovering'); assert.ok(f.repository.getTask('task').nextRunAt);
    assert.equal(f.repository.queue.attempts('task').length, 1);
  } finally { await scheduler.shutdown(); await f.cleanup(); }
});
