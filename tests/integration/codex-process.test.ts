import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { SupervisedCodexExecutor, liveProcessGroup } from '../../packages/core/src/supervised-codex-executor.js';
const executor = (mode = 'normal') => new SupervisedCodexExecutor({ entry: resolve('dist/tests/fixtures/codex-process-worker.js'), graceMs: 50, env: { ...process.env, CTX_PROCESS_FIXTURE: mode } });
const input = () => ({ prompt: 'fixture', workspacePath: process.cwd(), signal: new AbortController().signal, async onRawEvent(_event: unknown) {} });
test('supervisor acknowledges events only after durable callback and records owned process identity', async () => {
  let pgid = 0; const events: unknown[] = [];
  const result = await executor().run({ ...input(), onProcess(info) { pgid = info.pgid; assert.equal(info.pid, info.pgid); assert.notEqual(info.identity, 'unknown'); }, async onRawEvent(event) { events.push(event); } });
  assert.equal(result.exitCode, 0); assert.equal(result.spawned, true); assert.equal(events.length, 1); assert.deepEqual(liveProcessGroup(pgid), []);
});
test('pre-cancelled supervisor never spawns', async () => {
  const abort = new AbortController(); abort.abort();
  const result = await executor().run({ ...input(), signal: abort.signal, onProcess() { assert.fail('must not spawn'); } });
  assert.equal(result.spawned, false); assert.equal(result.aborted, true);
});
test('cancellation kills a resistant worker and its descendant before settling', async () => {
  const abort = new AbortController(); let pgid = 0;
  const result = await executor('cancel').run({ ...input(), signal: abort.signal, onProcess(info) { pgid = info.pgid; }, async onRawEvent() { abort.abort(); } });
  assert.equal(result.aborted, true); assert.deepEqual(liveProcessGroup(pgid), []);
});
test('normal leader exit still cleans resistant descendants', async () => {
  let pgid = 0;
  const result = await executor('descendant').run({ ...input(), onProcess(info) { pgid = info.pgid; } });
  assert.equal(result.exitCode, 0); assert.deepEqual(liveProcessGroup(pgid), []);
});
test('abnormal child exit is not successful execution', async () => {
  const result = await executor('abnormal').run(input());
  assert.equal(result.exitCode, null); assert.equal(result.exitSignal, 'SIGKILL');
});
test('event sink failure terminates the worker and preserves the persistence error', async () => {
  let pgid = 0;
  await assert.rejects(executor('cancel').run({ ...input(), onProcess(info) { pgid = info.pgid; }, async onRawEvent() { throw new Error('stale fence'); } }), /stale fence/);
  assert.deepEqual(liveProcessGroup(pgid), []);
});

test('SDK host kills its group after its supervising parent is SIGKILLed', { timeout: 15000 }, async () => {
  const { mkdtemp, rm } = await import('node:fs/promises'); const { tmpdir } = await import('node:os');
  const { join } = await import('node:path'); const { fork } = await import('node:child_process');
  const { setTimeout: delay } = await import('node:timers/promises');
  const { fakeCodex } = await import('../fixtures/fake-codex.js');
  const root = await mkdtemp(join(tmpdir(), 'ctx-sdk-orphan-')); const executable = await fakeCodex(root);
  const child = fork(resolve('dist/tests/fixtures/codex-supervisor-owner.js'), [executable, root], { execArgv: [], env: { ...process.env, NODE_TEST_CONTEXT: undefined, CTX_SDK_FIXTURE: 'hang' }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  let pgid = 0; const exited = once(child, 'exit');
  const running = new Promise<void>(resolve => child.on('message', value => { const frame = value as { type: string; pgid: number }; pgid = frame.pgid; if (frame.type === 'running') resolve(); }));
  let deadline: NodeJS.Timeout | undefined;
  try {
    await Promise.race([running, exited.then(() => { throw new Error('Fixture owner exited early'); }), new Promise<never>((_resolve, reject) => { deadline = setTimeout(() => reject(new Error('SDK fixture startup timed out')), 8000); })]);
    clearTimeout(deadline); assert.ok(liveProcessGroup(pgid).length >= 2);
    child.kill('SIGKILL'); await exited;
    const until = Date.now() + 8000;
    while (liveProcessGroup(pgid).length && Date.now() < until) await delay(25);
    assert.deepEqual(liveProcessGroup(pgid), []);
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    if (pgid && liveProcessGroup(pgid).length) process.kill(-pgid, 'SIGKILL');
    await rm(root, { recursive: true, force: true });
  }
});
