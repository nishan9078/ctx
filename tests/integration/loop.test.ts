import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runTask } from '../../packages/core/src/orchestrator.js';
import type { AgentAdapter } from '../../packages/agents/src/agent-adapter.js';
import { prepareWorkspace } from '../../packages/environment/src/workspace.js';
import { runProcess } from '../../packages/environment/src/process-manager.js';
const fixture = resolve('tests/fixtures/feature');
const featureAgent: AgentAdapter = { async execute(input) {
  await writeFile(join(input.workspacePath, 'feature.js'), 'export const added = true;\n');
  await writeFile(join(input.workspacePath, 'index.js'), 'export function greet(name) { return `Hello, ${name}!`; }\nexport const version = 2;\n');
  await input.onEvent?.({ type: 'thread.started', data: { thread_id: 'fake-session' } });
  return { outcome: 'completed', summary: 'Added feature', sessionId: 'fake-session' };
} };
test('fixture feature produces real diff, passing checks and persisted evidence without source changes', async () => {
  const output = await mkdtemp(join(tmpdir(), 'harness-test-'));
  const before = await readFile(join(fixture, 'index.js'), 'utf8');
  let workspace: string | undefined;
  try {
    const { report, directory } = await runTask({ environment: { mode: 'host' }, request: 'Add version and feature', repositoryPath: fixture, outputDirectory: output }, featureAgent);
    workspace = report.workspacePath;
    assert.equal(report.outcome, 'completed'); assert.equal(report.verification.length, 2);
    assert.ok(report.verification.every(check => check.status === 'passed'));
    const diff = await readFile(report.implemented.diff, 'utf8'); assert.match(diff, /feature.js/); assert.match(diff, /version = 2/);
    assert.equal(await readFile(join(fixture, 'index.js'), 'utf8'), before);
    assert.match(await readFile(join(directory, 'test.log'), 'utf8'), /pass 1/);
    assert.match(await readFile(join(directory, 'events.jsonl'), 'utf8'), /agent.thread.started/);
    assert.equal(JSON.parse(await readFile(join(directory, 'report.json'), 'utf8')).security.status, 'unavailable');
    for (const command of ['status', 'logs', 'diff']) {
      const result = await runProcess(process.execPath, [resolve('dist/apps/cli/src/index.js'), command, report.id, '--output', output], fixture);
      assert.equal(result.code, 0, result.output);
      assert.match(result.output, command === 'status' ? /completed/ : command === 'logs' ? /task.finished/ : /feature.js/);
    }
  } finally { await rm(output, { recursive: true, force: true }); if (workspace) await rm(resolve(workspace, '..'), { recursive: true, force: true }); }
});
for (const scenario of ['failed-test', 'missing-check', 'agent-failed', 'cancelled'] as const) test(`does not claim completion: ${scenario}`, async () => {
  const output = await mkdtemp(join(tmpdir(), 'harness-failure-'));
  let workspace: string | undefined;
  try {
    const { report } = await runTask({ environment: { mode: 'host' }, request: 'feature', repositoryPath: fixture, outputDirectory: output,
      test: scenario === 'failed-test' ? 'exit 7' : scenario === 'missing-check' ? '' : undefined,
      signal: scenario === 'cancelled' ? AbortSignal.abort() : undefined,
    }, scenario === 'agent-failed' ? { async execute() { return { outcome: 'failed', summary: 'Auth missing' }; } } : featureAgent);
    workspace = report.workspacePath;
    assert.equal(report.outcome, scenario === 'cancelled' ? 'cancelled' : scenario === 'missing-check' ? 'blocked' : 'failed');
    if (scenario === 'agent-failed') assert.equal(report.verification.length, 0);
    if (scenario === 'failed-test') assert.equal(report.verification[1].exitCode, 7);
  } finally { await rm(output, { recursive: true, force: true }); if (workspace) await rm(resolve(workspace, '..'), { recursive: true, force: true }); }
});
test('process timeout stops a hung command', async () => {
  const started = Date.now(); const result = await runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], fixture, { timeoutMs: 50 });
  assert.equal(result.timedOut, true); assert.ok(Date.now() - started < 5000);
});
test('CLI validates command and timeout', async () => {
  const cli = resolve('dist/apps/cli/src/index.js');
  const result = await runProcess(process.execPath, [cli, 'run', 'feature', '--timeout=-1'], fixture);
  assert.equal(result.code, 1); assert.match(result.output, /Timeout/);
});

test('workspace rejects symlinks and prevents copying inside the source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-workspace-'));
  try {
    await assert.rejects(prepareWorkspace(root, join(root, 'child')), /outside source/);
    const source = join(root, 'source'); const target = join(root, 'target');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(source); await symlink('/etc/passwd', join(source, 'link'));
    await assert.rejects(prepareWorkspace(source, target), /Symlinks/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
