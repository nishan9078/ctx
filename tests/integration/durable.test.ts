import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { TaskStore } from '../../packages/persistence/src/database.js';
import { runTask, resumeTask, databasePath } from '../../packages/core/src/orchestrator.js';
import type { TaskRecord } from '../../packages/core/src/types.js';
const fixture = resolve('tests/fixtures/feature');
async function root() { return mkdtemp(join(tmpdir(), 'harness-durable-test-')); }
async function cleanup(output: string, workspace?: string) {
  await rm(output, { force: true, recursive: true });
  if (workspace) await rm(resolve(workspace, '..'), { force: true, recursive: true });
}
async function until<T>(read: () => Promise<T | undefined>, timeout = 10_000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await read(); if (value !== undefined) return value; await delay(20); }
  throw new Error('Timed out waiting for crash boundary');
}
for (const mode of ['confirmed', 'ambiguous', 'verification'] as const) test(`SIGKILL recovery: ${mode}`, { timeout: 20_000 }, async () => {
  const output = await root(); let workspace: string | undefined;
  const worker = fork(resolve('dist/tests/fixtures/durable-worker.js'), [output, fixture, mode], { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let errors = ''; worker.stderr?.on('data', data => { errors += data.toString(); });
  const exited = once(worker, 'exit');
  try {
    let task: TaskRecord;
    if (mode !== 'verification') {
      const message = await Promise.race([once(worker, 'message'), exited.then(() => { throw new Error(`Worker exited before checkpoint: ${errors}`); })]);
      workspace = (message[0] as { workspace: string }).workspace;
      const store = new TaskStore(databasePath(output)); try { task = store.list()[0]; } finally { store.close(); }
    } else {
      task = await until(async () => {
        try {
          const store = new TaskStore(databasePath(output));
          try {
            const value = store.list()[0]; if (!value || value.activeCheck !== 'build') return;
            await readFile(join(value.workspacePath, 'build-effects')); return value;
          } finally { store.close(); }
        } catch { return; }
      });
      workspace = task.workspacePath;
    }
    assert.equal(task.status, mode === 'verification' ? 'verifying' : 'executing');
    // An active worker cannot be stolen even if its lease timestamp expires.
    await assert.rejects(resumeTask({ id: task.id, outputDirectory: output, leaseDurationMs: 300 }, { async execute() { throw new Error('Must not launch'); } }), /lease is held/);
    worker.kill('SIGKILL'); await exited; await delay(650);
    let calls = 0;
    const recovered = await resumeTask({ id: task.id, outputDirectory: output, leaseDurationMs: 300 }, { async execute(input) {
      calls++; assert.match(input.prompt, /Second/);
      await writeFile(join(input.workspacePath, 'second.js'), 'export const second = true;\n');
      return { outcome: 'completed', summary: 'Second feature done' };
    } });
    assert.equal(await readFile(join(workspace!, 'agent-effects'), 'utf8'), mode === 'verification' ? 'once\nonce\n' : 'once\n');
    if (mode === 'confirmed') {
      assert.equal(recovered.report.outcome, 'completed'); assert.equal(calls, 1);
      assert.ok(recovered.report.verification.every(check => check.status === 'passed'));
      const store = new TaskStore(databasePath(output));
      try {
        assert.ok(store.events(task.id).some(event => event.type === 'attempt.reconciled'));
        assert.deepEqual(store.get(task.id).plan.steps.map(step => step.status), ['passed', 'passed']);
        assert.equal(store.get(task.id).attempts[0].sessionId, 'durable-session');
        assert.equal((store.db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok');
      } finally { store.close(); }
      const again = await resumeTask({ id: task.id, outputDirectory: output }, { async execute() { throw new Error('Terminal task must not rerun'); } });
      assert.equal(again.report.outcome, 'completed');
      assert.equal(again.report.usage.elapsedMs, recovered.report.usage.elapsedMs);
    } else {
      assert.equal(recovered.report.outcome, 'blocked'); assert.equal(calls, 0);
      assert.match(recovered.report.implemented.summary, /unknown outcome/);
      if (mode === 'verification') assert.equal(await readFile(join(workspace!, 'build-effects'), 'utf8'), 'once\n');
    }
  } finally { if (worker.exitCode === null && worker.signalCode === null) { worker.kill('SIGKILL'); await exited; } await cleanup(output, workspace); }
});
test('repairs are bounded, reuse sessions, preserve evidence, and persist consumed budget', async () => {
  const output = await root(); let workspace: string | undefined; let calls = 0;
  try {
    const result = await runTask({ environment: { mode: 'host' }, request: 'feature', repositoryPath: fixture, outputDirectory: output, maxRepairAttempts: 1,
      test: `node -e 'process.exit(require("fs").existsSync("fixed")?0:1)'`,
    }, { async execute(input) {
      calls++; if (calls === 2) { assert.equal(input.sessionId, 'repair-session'); assert.match(input.prompt, /Repair the concrete verification failures/); await writeFile(join(input.workspacePath, 'fixed'), 'fixed'); }
      return { outcome: 'completed', summary: 'done', sessionId: 'repair-session' };
    } });
    workspace = result.report.workspacePath;
    assert.equal(result.report.outcome, 'completed'); assert.equal(calls, 2); assert.equal(result.report.usage.retries, 1);
    const store = new TaskStore(databasePath(output));
    try {
      const task = store.get(result.report.id); assert.equal(task.remainingRepairAttempts, 0); assert.equal(task.attempts.length, 2);
      assert.match(await readFile(join(result.directory, 'test.log'), 'utf8'), /^$/); // Failed check's original log retained.
      assert.equal(task.verification[1].status, 'passed'); assert.match(task.verification[1].artifact, /verification-1/);
    } finally { store.close(); }
  } finally { await cleanup(output, workspace); }
});
test('budget exhaustion stops without extra agent attempts', async () => {
  const output = await root(); let workspace: string | undefined; let calls = 0;
  try {
    const result = await runTask({ environment: { mode: 'host' }, request: 'feature', repositoryPath: fixture, outputDirectory: output, maxRepairAttempts: 1, test: 'exit 9' }, { async execute() { calls++; return { outcome: 'completed', summary: 'done' }; } });
    workspace = result.report.workspacePath; assert.equal(result.report.outcome, 'failed'); assert.equal(calls, 2);
    const store = new TaskStore(databasePath(output));
    try { assert.equal(store.get(result.report.id).remainingRepairAttempts, 0); } finally { store.close(); }
  } finally { await cleanup(output, workspace); }
});
test('invalid transitions roll back both state and event writes', async () => {
  const output = await root(); let workspace: string | undefined;
  try {
    const result = await runTask({ environment: { mode: 'host' }, request: 'feature', repositoryPath: fixture, outputDirectory: output }, { async execute() { return { outcome: 'completed', summary: 'done' }; } }); workspace = result.report.workspacePath;
    const store = new TaskStore(databasePath(output)); const owner = store.claim(result.report.id, 1000);
    try {
      const before = store.events(result.report.id).length;
      assert.throws(() => store.update(result.report.id, owner, 'invalid', {}, task => { task.status = 'executing'; }), /Invalid task transition/);
      assert.equal(store.get(result.report.id).status, 'completed'); assert.equal(store.events(result.report.id).length, before);
      assert.throws(() => store.update(result.report.id, 'wrong-owner', 'invalid', {}), /lost task lease/);
    } finally { store.release(result.report.id, owner); store.close(); }
  } finally { await cleanup(output, workspace); }
});
