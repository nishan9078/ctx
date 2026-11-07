import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { runOwnedCommand } from '../../packages/environment/src/owned-command.js';
import { liveProcessGroup } from '../../packages/environment/src/process-group.js';
test('owned commands preserve exit/output and cancellation reaps their group', async () => {
  const success = await runOwnedCommand(process.execPath, ['-e', 'console.log("owned output");console.error("owned error");process.exitCode=7'], process.cwd());
  assert.equal(success.code, 7); assert.match(success.output, /owned output/); assert.match(success.output, /owned error/);
  let pgid = 0;
  const result = await runOwnedCommand(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], process.cwd(), { timeoutMs: 100, onProcess(id) { pgid = id; } });
  assert.equal(result.timedOut, true); assert.deepEqual(liveProcessGroup(pgid), []);
});
for (const mode of ['single', 'session']) test(`controller SIGKILL stops ${mode} preparation commands and inherited-output descendants`, { timeout: 15000 }, async () => {
  const parent = fork(resolve('dist/tests/fixtures/owned-command-owner.js'), [mode], { execArgv: [], env: { ...process.env, NODE_TEST_CONTEXT: undefined }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const exited = once(parent, 'exit'); let pgid = 0; let timer: NodeJS.Timeout | undefined;
  const running = new Promise<void>(resolve => parent.on('message', message => { const frame = message as { type: string; pgid: number }; if (frame.type === 'owned') pgid = frame.pgid; if (frame.type === 'running') resolve(); }));
  try {
    await Promise.race([running, exited.then(() => { throw new Error('Preparation owner exited too early'); }), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Preparation startup timed out')), 8000); })]); clearTimeout(timer);
    assert.ok(liveProcessGroup(pgid).length >= 2); parent.kill('SIGKILL'); await exited;
    const until = Date.now() + 5000; while (liveProcessGroup(pgid).length && Date.now() < until) await delay(25);
    assert.deepEqual(liveProcessGroup(pgid), []);
  } finally { clearTimeout(timer); if (parent.exitCode === null && parent.signalCode === null) parent.kill('SIGKILL'); if (pgid && liveProcessGroup(pgid).length) process.kill(-pgid, 'SIGKILL'); }
});

test('scoped command sessions serialize results through one host and close without leftovers', async () => {
  const { OwnedCommandSession } = await import('../../packages/environment/src/owned-command-session.js');
  let spawned = 0; let pgid = 0; const session = new OwnedCommandSession({ onProcess(id) { spawned++; pgid = id; } });
  try {
    const [first, second] = await Promise.all([session.run(process.execPath, ['-e', 'console.log("first")'], process.cwd()), session.run(process.execPath, ['-e', 'console.log("second")'], process.cwd())]);
    assert.equal(first.output, 'first\n'); assert.equal(second.output, 'second\n'); assert.equal(spawned, 1);
  } finally { await session.close(); }
  assert.deepEqual(liveProcessGroup(pgid), []); await assert.rejects(session.run(process.execPath, ['-e', ''], process.cwd()), /closed/);
});
