import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runTask } from '../../packages/core/src/orchestrator.js';
import { codexEntrypoint } from '../../apps/cli/src/terminal.js';
import { runProcess } from '../../packages/environment/src/process-manager.js';
test('CTX interface opens, configures a repository, and reviews a real saved task/diff', { timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'ctx-terminal-test-')); const source = join(root, 'source'); await mkdir(source);
  await writeFile(join(source, 'package.json'), '{"scripts":{"build":"true","test":"true"}}'); let workspace: string | undefined;
  let child: ReturnType<typeof spawn> | undefined; let exited: Promise<unknown> | undefined;
  try {
    const task = await runTask({ request: 'Add a feature', repositoryPath: source, environment: { mode: 'host' } }, { async execute(input) { await writeFile(join(input.workspacePath, 'feature.js'), 'export const feature = true;'); return { outcome: 'completed', summary: 'Feature implemented' }; } }); workspace = task.report.workspacePath;
    child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', resolve('dist/apps/cli/src/index.js'), '--repo', source], { stdio: ['pipe', 'pipe', 'pipe'] });
    exited = once(child, 'exit'); let output = ''; child.stdout!.on('data', data => { output += data.toString(); }); child.stderr!.on('data', data => { output += data.toString(); });
    const waitFor = (text: string) => new Promise<void>((resolveResult, reject) => {
      const timer = setTimeout(() => { clearInterval(poll); reject(new Error(`Missing UI text ${text}: ${output}`)); }, 5000);
      const poll = setInterval(() => { if (output.includes(text)) { clearTimeout(timer); clearInterval(poll); resolveResult(); } }, 10);
    });
    await waitFor('ctx >'); assert.match(output, /CTX/);
    child.stdin!.write('/help\n'); await waitFor('/security');
    child.stdin!.write('/set execution host\n'); await waitFor('Updated execution.');
    child.stdin!.write('/tasks\n'); await waitFor(task.report.id);
    child.stdin!.write(`/status ${task.report.id}\n`); await waitFor('Changes are ready for review.');
    child.stdin!.write(`/diff ${task.report.id}\n`); await waitFor('feature.js');
    child.stdin!.write('/quit\n'); const [code] = await exited as [number]; assert.equal(code, 0);
    assert.doesNotMatch(output, /@openai|codex-sdk|codex-security/); assert.match(output, /Session closed/);
  } finally { if (child && child.exitCode === null) { child.kill('SIGKILL'); await exited; } await rm(root, { recursive: true, force: true }); if (workspace) await rm(resolve(workspace, '..'), { recursive: true, force: true }); }
});
test('security engine package imports and validates its runtime without pretending to scan', async () => {
  const result = await runProcess(process.execPath, [resolve('dist/packages/security/src/worker.js'), '--check'], process.cwd(), { timeoutMs: 15_000 });
  assert.equal(result.code, 0, result.output); assert.match(result.output, /Security engine ready/);
});

test('bundled execution runtime resolves through ESM exports for sign-in and diagnostics', async () => {
  const result = await runProcess(process.execPath, [codexEntrypoint(), '--version'], process.cwd());
  assert.equal(result.code, 0, result.output); assert.match(result.output, /0\.166\.0/);
});
