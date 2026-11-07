import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { writeFile, mkdir, readFile, symlink } from 'node:fs/promises';
import { SupervisedCodexExecutor, liveProcessGroup } from '../../packages/core/src/supervised-codex-executor.js';
import { createCodexQueueScheduler } from '../../packages/core/src/codex-queue-worker.js';
import { RuntimeSampler, enforceRuntimeBudget, directoryBytes } from '../../packages/environment/src/runtime-health.js';
import { workerRuntimeBudget, runtimeBudgetFromConfig } from '../../packages/shared/src/runtime.js';
import { validateConfig } from '../../packages/core/src/config.js';
import { codexFixture } from '../fixtures/codex.js';
import { submissionFixture } from '../fixtures/repository.js';
import { repositoryActor as actor } from '../fixtures/repository.js';
import { fakeCodex } from '../fixtures/fake-codex.js';
import type { RuntimeHealth } from '../../packages/shared/src/runtime.js';
const input = () => ({ prompt: 'fixture', workspacePath: process.cwd(), signal: new AbortController().signal, async onRawEvent() {} });
test('runtime policy validates config budgets and rejects low disk/RAM, worker RSS/CPU and workspace overflow', async () => {
  const config = validateConfig({ schemaVersion: 1, projects: [], runtime: { maxWorkerRssMb: 512, maxWorkerCpuSeconds: 30, maxWorkspaceMb: 64, worktreeRetentionDays: 0 } });
  const budget = runtimeBudgetFromConfig(config.runtime); assert.equal(budget.maxRssBytes, 512 * 1024 ** 2); assert.equal(budget.maxCpuMs, 30000); assert.equal(config.runtime.worktreeRetentionDays, 0);
  assert.throws(() => workerRuntimeBudget({ sampleMs: 0 })); assert.throws(() => validateConfig({ schemaVersion: 1, projects: [], runtime: { maxWorkspaceMb: -1 } }));
  const healthy: RuntimeHealth = { timestamp: new Date().toISOString(), pids: [], rssBytes: 0, observedCpuMs: 0, workspaceBytes: 0, freeDiskBytes: budget.minFreeDiskBytes, availableMemoryBytes: budget.minAvailableMemoryBytes };
  for (const delta of [{ freeDiskBytes: 0 }, { availableMemoryBytes: 0 }, { rssBytes: budget.maxRssBytes + 1 }, { observedCpuMs: budget.maxCpuMs + 1 }, { workspaceBytes: budget.maxWorkspaceBytes + 1 }]) assert.throws(() => enforceRuntimeBudget({ ...healthy, ...delta }, budget), /Runtime budget/);
  enforceRuntimeBudget(healthy, budget);
});
test('actual Linux health reads disk/memory and rejects symlinked workspace paths', async () => {
  const f = await codexFixture();
  try {
    await writeFile(join(f.project, 'data'), '1234'); assert.equal(await directoryBytes(f.project), 4);
    const health = await new RuntimeSampler().sample(f.root, f.project); assert.equal(health.workspaceBytes, 4); assert.ok(health.availableMemoryBytes > 0); assert.ok(health.freeDiskBytes > 0);
    await symlink(f.root, join(f.project, 'escape')); await assert.rejects(directoryBytes(f.project), /symlink/);
  } finally { await f.cleanup(); }
});
for (const limit of ['maxCpuMs', 'maxRssBytes', 'maxWallMs'] as const) test(`supervisor ${limit} violation stops and reaps the owned group`, { timeout: 15000 }, async () => {
  let pgid = 0; const samples: RuntimeHealth[] = [];
  const supervisor = new SupervisedCodexExecutor({ entry: resolve('dist/tests/fixtures/codex-process-worker.js'), graceMs: 50, runtime: { [limit]: limit === 'maxRssBytes' ? 1 : 50, sampleMs: 50 }, env: { ...process.env, CTX_PROCESS_FIXTURE: 'burn' } });
  await assert.rejects(supervisor.run({ ...input(), onProcess(info) { pgid = info.pgid; }, onHealth(health) { samples.push(health); } }), /budget/);
  assert.deepEqual(liveProcessGroup(pgid), []); assert.ok(samples.length > 0);
});
test('stdout and stderr are captured separately with explicit truncation', async () => {
  const supervisor = new SupervisedCodexExecutor({ entry: resolve('dist/tests/fixtures/codex-process-worker.js'), env: { ...process.env, CTX_PROCESS_FIXTURE: 'output' } });
  const result = await supervisor.run(input()); assert.equal(result.exitCode, 0); assert.equal(result.stdoutTruncated, true); assert.equal(result.stderrTruncated, true);
  assert.equal(result.stdoutTail!.length, 16384); assert.equal(result.stderrTail.length, 16384);
});
test('low disk preflight never launches a worker or creates a workspace', async () => {
  const f = await codexFixture(); let launched = false;
  const scheduler = createCodexQueueScheduler(f.repository, { runtime: { minFreeDiskBytes: Number.MAX_SAFE_INTEGER }, executor: { async run() { launched = true; throw new Error('unexpected'); } } });
  try {
    assert.equal((await scheduler.runUntilIdle()).blocked, 1); assert.equal(launched, false); assert.deepEqual(f.repository.workspaces.list(), []);
    const attempt = f.repository.queue.attempts('task')[0]; assert.ok(f.repository.queue.workerEvents(attempt.id).some(e => e.type === 'failed' && (e.payload as { code: string }).code === 'BUDGET_EXHAUSTED'));
  } finally { await scheduler.shutdown(); await f.cleanup(); }
});
test('queue records runtime health and archives final workspace before releasing exclusive ownership', async () => {
  const f = await codexFixture(); const path = await fakeCodex(f.root);
  const scheduler = createCodexQueueScheduler(f.repository, { probe: async () => ({ sdkVersion: '0.166.0', cliVersion: 'fixture', cliAvailable: true, auth: 'auth-file', model: 'unknown', provider: 'unknown', probeErrors: [] }), executor: new SupervisedCodexExecutor({ codexPathOverride: path }) });
  try {
    assert.equal((await scheduler.runUntilIdle()).blocked, 1); const workspace = f.repository.workspaces.list()[0]; assert.equal(workspace.state, 'archived');
    f.repository.workspaces.assertQuiescent(workspace.id); assert.ok(workspace.archiveArtifactId);
    const archive = await f.repository.verifyStoredArtifact(workspace.archiveArtifactId!); const receipt = JSON.parse(await readFile(join(f.repository.dataDirectory, archive.location), 'utf8'));
    assert.equal(receipt.baseSha, workspace.identity.baseSha); assert.equal(receipt.treeHash, workspace.archiveTreeHash);
    const health = f.repository.queue.workerEvents(workspace.id).filter(event => event.type === 'runtime.health'); assert.ok(health.length >= 2);
    assert.ok(health.some(event => (event.payload as RuntimeHealth).rssBytes > 0));
  } finally { await scheduler.shutdown(); await f.cleanup(); }
});

test('two concurrent fixture tasks write only their distinct owned worktrees', async () => {
  const f = await codexFixture(); const executable = await fakeCodex(f.root);
  f.repository.queue.configure({ maxWorkers: 2, maxWorkersPerProject: 2 }, actor); f.repository.submitTask(submissionFixture('second'), actor);
  const scheduler = createCodexQueueScheduler(f.repository, { probe: async () => ({ sdkVersion: '0.166.0', cliVersion: 'fixture', cliAvailable: true, auth: 'auth-file', model: 'unknown', provider: 'unknown', probeErrors: [] }), executor: new SupervisedCodexExecutor({ codexPathOverride: executable }) });
  try {
    assert.equal((await scheduler.runUntilIdle()).blocked, 2); const workspaces = f.repository.workspaces.list(); assert.equal(workspaces.length, 2);
    assert.notEqual(workspaces[0].identity.worktree, workspaces[1].identity.worktree); assert.notEqual(workspaces[0].identity.worktreeInode, workspaces[1].identity.worktreeInode);
    for (const workspace of workspaces) { assert.equal(await readFile(join(workspace.identity.worktree, 'result.txt'), 'utf8'), 'fixture change\n'); assert.equal(workspace.state, 'archived'); }
    await assert.rejects(readFile(join(f.project, 'result.txt')), { code: 'ENOENT' });
  } finally { await scheduler.shutdown(); await f.cleanup(); }
});

test('a fast disk writer cannot evade the final workspace budget check', async () => {
  const f = await codexFixture(); let pgid = 0;
  try {
    const executor = new SupervisedCodexExecutor({ entry: resolve('dist/tests/fixtures/codex-process-worker.js'), runtime: { maxWorkspaceBytes: 1024 * 1024 }, env: { ...process.env, CTX_PROCESS_FIXTURE: 'disk' } });
    await assert.rejects(executor.run({ ...input(), workspacePath: f.project, resourceRoot: f.project, onProcess(info) { pgid = info.pgid; } }), /workspace disk/);
    assert.deepEqual(liveProcessGroup(pgid), []); assert.equal((await directoryBytes(f.project)), 2 * 1024 * 1024);
  } finally { await f.cleanup(); }
});
test('resource sink failure terminates the group before returning a lost fence', async () => {
  let pgid = 0; const executor = new SupervisedCodexExecutor({ entry: resolve('dist/tests/fixtures/codex-process-worker.js') });
  await assert.rejects(executor.run({ ...input(), onProcess(info) { pgid = info.pgid; }, onHealth() { throw new Error('Lost resource fence'); } }), /Lost resource fence/);
  assert.deepEqual(liveProcessGroup(pgid), []);
});
