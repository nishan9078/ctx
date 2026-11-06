import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { runTask } from '../../packages/core/src/orchestrator.js';
import { requiredChecksPass } from '../../packages/verification/src/execute-plan.js';
import { planVerification } from '../../packages/verification/src/planner.js';
const html = '<!doctype html><html><body><canvas id="game" width="400" height="600"></canvas><script>let score=0; function flap(){score++;} document.addEventListener("keydown",flap);</script></body></html>';
async function fixture(work: (source: string, output: string, keep: (path: string) => void) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'ctx-plan-')); const source = join(root, 'source'); await mkdir(source); const workspaces = new Set<string>();
  try { await work(source, join(root, 'runs'), path => workspaces.add(path)); }
  finally { for (const path of workspaces) await rm(dirname(path), { recursive: true, force: true }); await rm(root, { recursive: true, force: true }); }
}
test('standalone HTML Flappy Bird without package.json completes with independent syntax and honest unavailable browser evidence', async () => fixture(async (source, output, keep) => {
  const result = await runTask({ request: 'Build a standalone Flappy Bird game in one HTML file named index.html', repositoryPath: source, outputDirectory: output, environment: { mode: 'auto' } }, { async execute(input) { keep(input.workspacePath); await writeFile(join(input.workspacePath, 'index.html'), html); return { outcome: 'completed', summary: 'All tests and gameplay checks passed!' }; } });
  assert.equal(result.report.outcome, 'completed', JSON.stringify(result.report)); assert.equal(result.report.environment.execution, 'filesystem');
  assert.ok(requiredChecksPass(result.report.verification));
  assert.equal(result.report.verification.find(check => check.name === 'test')?.status, 'not-applicable');
  assert.equal(result.report.verification.find(check => check.name === 'syntax')?.status, 'passed');
  const browser = result.report.verification.find(check => check.name === 'browser')!; assert.equal(browser.requirement, 'optional'); assert.equal(browser.status, 'unavailable');
  assert.match(await readFile(browser.artifact, 'utf8'), /No isolation downgrade|requires explicit host|requires.*host/i);
  assert.match(await readFile(join(result.directory, 'syntax.log'), 'utf8'), /--check/);
  assert.match(await readFile(join(result.directory, 'verification-plan.json'), 'utf8'), /static-html/);
  assert.ok(result.report.limitations.some(item => /Optional browser/.test(item)));
}));
test('HTML script extraction parses real HTML semantics: module scripts, JSON, event handlers, and invalid JS', async () => fixture(async (source, output, keep) => {
  for (const [index, code, expected] of [[0, '<script type="module">import x from "./missing.js"; await Promise.resolve();</script><script type="application/json">{"value":"not javascript"}</script>', 'completed'], [1, '<script>function broken( {</script>', 'failed'], [2, '<button onclick="let = ;">Click</button><script>void 0;</script>', 'failed']] as const) {
    const result = await runTask({ request: 'Create index.html as standalone HTML', repositoryPath: source, outputDirectory: join(output, String(index)), environment: { mode: 'auto' } }, { async execute(input) { keep(input.workspacePath); await writeFile(join(input.workspacePath, 'index.html'), '<html><body>' + code + '</body></html>'); return { outcome: 'completed', summary: 'Syntax passed, trust me' }; } });
    assert.equal(result.report.outcome, expected, JSON.stringify(result.report));
  }
}));
test('an explicit custom test is mandatory and a missing required command blocks precisely', async () => fixture(async (source, output, keep) => {
  for (const [index, command, expected] of [[0, 'test -s index.html && printf CUSTOM_VERIFIED', 'completed'], [1, '', 'blocked']] as const) {
    const result = await runTask({ request: 'Create standalone index.html', repositoryPath: source, outputDirectory: join(output, String(index)), test: command, environment: { mode: 'host' } }, { async execute(input) { keep(input.workspacePath); await writeFile(join(input.workspacePath, 'index.html'), html); return { outcome: 'completed', summary: 'Tests passed' }; } });
    assert.equal(result.report.outcome, expected, JSON.stringify(result.report)); const check = result.report.verification.find(item => item.name === 'test')!; assert.equal(check.requirement, 'mandatory');
    if (command) { assert.equal(check.command, command); assert.match(await readFile(check.artifact, 'utf8'), /CUSTOM_VERIFIED/); } else { assert.equal(check.status, 'unavailable'); assert.match(await readFile(check.artifact, 'utf8'), /no command or configured runner/); }
  }
}));
test('a required browser check cannot be removed or conflated with passing syntax', async () => fixture(async (source, output, keep) => {
  const result = await runTask({ request: 'Create standalone index.html', browser: '', repositoryPath: source, outputDirectory: output, environment: { mode: 'auto' } }, { async execute(input) { keep(input.workspacePath); await writeFile(join(input.workspacePath, 'index.html'), html); return { outcome: 'completed', summary: 'Browser tests passed' }; } });
  assert.equal(result.report.outcome, 'blocked'); assert.equal(result.report.verification.find(check => check.name === 'syntax')?.status, 'passed'); assert.equal(result.report.verification.find(check => check.name === 'browser')?.requirement, 'mandatory');
}));
test('an agent claim without generated artifacts cannot pass', async () => fixture(async (source, output, keep) => {
  const result = await runTask({ request: 'Build index.html', repositoryPath: source, outputDirectory: output, environment: { mode: 'auto' } }, { async execute(input) { keep(input.workspacePath); return { outcome: 'completed', summary: 'Created HTML; all tests passed.' }; } });
  assert.equal(result.report.outcome, 'failed'); assert.equal(result.report.verification.find(check => check.name === 'artifacts')?.status, 'failed');
}));
test('project classification distinguishes mixed, backend, documentation and configured runners', async () => fixture(async (source) => {
  await writeFile(join(source, 'index.html'), html); await writeFile(join(source, 'main.ts'), 'export const value: number = 1;'); await writeFile(join(source, 'pyproject.toml'), '[project]'); await writeFile(join(source, 'README.md'), '# Project');
  await writeFile(join(source, 'package.json'), JSON.stringify({ devDependencies: { vitest: '1' } }));
  const plan = await planVerification({ root: source, request: 'Implement a feature', commands: {}, forced: [], criteria: [] });
  for (const kind of ['static-html', 'typescript', 'backend', 'documentation', 'mixed']) assert.ok(plan.projects.includes(kind as any));
  assert.equal(plan.checks.find(check => check.id === 'test')?.command, 'node node_modules/vitest/vitest.mjs run');
}));

test('an available browser result becomes mandatory and cannot disappear on a repair', async () => fixture(async (source, output, keep) => {
  await writeFile(join(source, 'package.json'), JSON.stringify({ scripts: { 'test:browser': 'node -e "process.exit(1)"' } })); let attempts = 0;
  const result = await runTask({ request: 'Create standalone index.html', repositoryPath: source, outputDirectory: output, environment: { mode: 'host' }, maxRepairAttempts: 1 }, { async execute(input) {
    keep(input.workspacePath); attempts++; await writeFile(join(input.workspacePath, 'index.html'), html);
    if (attempts === 2) await writeFile(join(input.workspacePath, 'package.json'), '{}');
    return { outcome: 'completed', summary: 'Everything passes' };
  } });
  assert.equal(attempts, 2); assert.equal(result.report.outcome, 'blocked'); const browser = result.report.verification.find(check => check.name === 'browser')!; assert.equal(browser.requirement, 'mandatory'); assert.equal(browser.status, 'unavailable');
}));
