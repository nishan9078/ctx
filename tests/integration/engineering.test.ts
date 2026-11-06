import { requiredChecksPass } from '../../packages/verification/src/execute-plan.js';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runTask, databasePath } from '../../packages/core/src/orchestrator.js';
import { TaskStore } from '../../packages/persistence/src/database.js';
import type { AgentAdapter } from '../../packages/agents/src/agent-adapter.js';
import type { DockerDriver } from '../../packages/environment/src/types.js';
const exec = promisify(execFile);
const unavailable: DockerDriver = { kind: 'simulated', async command() { return { code: 1, output: 'Cannot connect to the Docker daemon', timedOut: false, truncated: false }; } };
async function fixture(run: (source: string, root: string, workspaces: string[]) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'ctx-engineering-')); const source = join(root, 'source'); await mkdir(source); const workspaces: string[] = [];
  try { await run(source, root, workspaces); } finally { for (const workspace of workspaces) await rm(dirname(workspace), { recursive: true, force: true }); await rm(root, { recursive: true, force: true }); }
}
const agent = (work: (workspace: string) => Promise<void>): AgentAdapter => ({ async execute(input) {
  await input.onEvent?.({ type: 'thread.started', data: { thread_id: 'fixture-session' } });
  await input.onEvent?.({ type: 'turn.started', data: {} });
  await input.onEvent?.({ type: 'item.started', data: { item: { id: 'tool', type: 'command_execution', command: 'fixture edit', status: 'in_progress' } } });
  await work(input.workspacePath);
  await input.onEvent?.({ type: 'item.completed', data: { item: { id: 'tool', type: 'command_execution', command: 'fixture edit', status: 'completed', aggregated_output: 'Fixture edit performed' } } });
  await input.onEvent?.({ type: 'turn.completed', data: { usage: { input_tokens: 1, output_tokens: 1 } } });
  return { outcome: 'completed', summary: 'Fixture work performed' };
} });

test('a simple folder request executes the agent and verifies an actual empty directory without Docker/build scripts', async () => fixture(async (source, root, workspaces) => {
  let dockerCalls = 0;
  await writeFile(join(source, 'package.json'), JSON.stringify({ dependencies: { pg: '8' } }));
  await writeFile(join(source, '.env.example'), 'DATABASE_URL=postgresql://example:example@postgres/example\n');
  await writeFile(join(source, '.harness-environment.json'), '{"services":{"postgres":true}}');
  const result = await runTask({ request: 'hello can you make a folder', repositoryPath: source, outputDirectory: join(root, 'runs'), environment: { mode: 'auto' } }, agent(async workspace => { workspaces.push(workspace); await mkdir(join(workspace, 'new-folder')); }), { docker: { kind: 'simulated', async command() { dockerCalls++; throw new Error('Docker must not be needed'); } } });
  assert.equal(result.report.outcome, 'completed'); assert.equal(dockerCalls, 0); assert.equal(result.report.execution?.codexStarted, true);
  assert.equal(result.report.environment.execution, 'filesystem'); assert.ok(result.report.implemented.hasChanges);
  assert.ok((await stat(join(result.report.workspacePath!, 'new-folder'))).isDirectory()); await assert.rejects(stat(join(source, 'new-folder')));
  assert.match(await readFile(result.report.acceptance!.manifest, 'utf8'), /new-folder/);
}));
test('file content acceptance is independent of an agent success claim', async () => fixture(async (source, root, workspaces) => {
  for (const correct of [false, true]) {
    const result = await runTask({ request: 'Create file note.txt with content "expected"', repositoryPath: source, outputDirectory: join(root, String(correct)), environment: { mode: 'auto' } }, agent(async workspace => { workspaces.push(workspace); await writeFile(join(workspace, 'note.txt'), correct ? 'expected' : 'wrong'); }));
    assert.equal(result.report.outcome, correct ? 'completed' : 'failed'); assert.equal(result.report.verification.find(check => check.name === 'acceptance')!.status, correct ? 'passed' : 'failed');
  }
}));
test('explicit checks on a filesystem request remain required', async () => fixture(async (source, root, workspaces) => {
  const result = await runTask({ request: 'Create folder demo', test: 'exit 9', repositoryPath: source, outputDirectory: join(root, 'runs'), environment: { mode: 'host' } }, agent(async workspace => { workspaces.push(workspace); await mkdir(join(workspace, 'demo')); }));
  assert.equal(result.report.outcome, 'failed'); assert.ok(result.report.verification.some(check => check.name === 'test' && check.status === 'failed'));
}));
test('application changes compile TypeScript and independently run tests', async () => fixture(async (source, root, workspaces) => {
  await writeFile(join(source, 'package.json'), JSON.stringify({ type: 'module', scripts: { build: `"${process.execPath}" "${createRequire(import.meta.url).resolve('typescript/bin/tsc')}" --target ES2022 --module NodeNext --moduleResolution NodeNext --outDir build math.ts`, test: 'node --test math.test.mjs' } }));
  await writeFile(join(source, '.gitignore'), 'build/\n');
  await writeFile(join(source, 'math.ts'), 'export function add(a: number, b: number): number { return a - b; }');
  await writeFile(join(source, 'math.test.mjs'), 'import {test} from "node:test"; import assert from "node:assert/strict"; import {add} from "./build/math.js"; test("sum",()=>assert.equal(add(2,3),5));');
  const result = await runTask({ request: 'Fix the TypeScript add function and keep its tests passing', repositoryPath: source, outputDirectory: join(root, 'runs'), environment: { mode: 'host' } }, agent(async workspace => { workspaces.push(workspace); await writeFile(join(workspace, 'math.ts'), 'export function add(a: number, b: number): number { return a + b; }'); }));
  assert.equal(result.report.outcome, 'completed', await readFile(result.report.verification.find(check => check.name === 'test')!.artifact, 'utf8')); assert.deepEqual(result.report.verification.filter(check => ['build', 'test'].includes(check.name)).map(check => check.name), ['build', 'test']); assert.match(await readFile(result.report.implemented.diff, 'utf8'), /return a \+ b/);
}));
test('auto never downgrades Docker without permission; authorized host fallback is journaled', async () => fixture(async (source, root, workspaces) => {
  await writeFile(join(source, 'package.json'), JSON.stringify({ scripts: { test: 'true' } }));
  for (const allowed of [false, true]) {
    let called = 0;
    const result = await runTask({ request: 'Implement an application change', repositoryPath: source, outputDirectory: join(root, String(allowed)), environment: { mode: 'auto', allowHostFallback: allowed } }, agent(async workspace => { workspaces.push(workspace); called++; }), { docker: unavailable });
    workspaces.push(result.report.workspacePath!); assert.equal(result.report.outcome, allowed ? 'completed' : 'blocked'); assert.equal(called, allowed ? 1 : 0);
    assert.equal(result.report.execution?.phase, allowed ? 'completed' : 'environment-failed');
    if (allowed) { assert.equal(result.report.environment.execution, 'host'); assert.match(await readFile(join(result.directory, 'events.jsonl'), 'utf8'), /selection.fallback/); }
  }
}));
test('host recovery installs a missing local dependency from a frozen lockfile only with explicit permission', async () => fixture(async (source, root, workspaces) => {
  await mkdir(join(source, 'vendor/local-dep'), { recursive: true });
  await writeFile(join(source, 'vendor/local-dep/package.json'), '{"name":"local-dep","version":"1.0.0","main":"index.cjs"}'); await writeFile(join(source, 'vendor/local-dep/index.cjs'), 'module.exports = 42;');
  await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'local-fixture', version: '1.0.0', dependencies: { 'local-dep': 'file:./vendor/local-dep' }, scripts: { test: 'node check.cjs' } }));
  await writeFile(join(source, 'check.cjs'), 'require("node:assert/strict").equal(require("local-dep"), 42); console.log("Dependency verified");');
  await exec('npm', ['install', '--package-lock-only', '--ignore-scripts', '--offline', '--no-audit', '--no-fund'], { cwd: source });
  for (const allowed of [false, true]) {
    const result = await runTask({ request: 'Verify the local dependency fixture', repositoryPath: source, outputDirectory: join(root, String(allowed)), environment: { mode: 'host', allowDependencyInstall: allowed } }, agent(async workspace => { workspaces.push(workspace); }));
    assert.equal(result.report.outcome, allowed ? 'completed' : 'blocked', JSON.stringify(result.report));
    if (allowed) { assert.equal(result.report.environment.recoveries?.[0].status, 'passed'); assert.match(await readFile(result.report.verification.find(check => check.name === 'test')!.artifact, 'utf8'), /Dependency verified/); }
  }
}));
test('the CTX release bundle cannot become a target repository', async () => fixture(async (source, root) => {
  await writeFile(join(source, 'release-manifest.json'), '{"product":"ctx"}'); let called = false;
  await assert.rejects(runTask({ request: 'Create folder demo', repositoryPath: source }, agent(async () => { called = true; })), /release bundle/); assert.equal(called, false);
}));

test('security-sensitive work cannot pass without its required security check', async () => fixture(async (source, root, workspaces) => {
  await writeFile(join(source, 'package.json'), JSON.stringify({ scripts: { test: 'true' } }));
  const result = await runTask({ request: 'Improve authentication', repositoryPath: source, outputDirectory: join(root, 'runs'), environment: { mode: 'host' } }, agent(async workspace => { workspaces.push(workspace); }));
  assert.equal(result.report.outcome, 'blocked'); assert.equal(result.report.execution?.phase, 'verification-failed');
  assert.ok(result.report.verification.some(check => check.name === 'security' && check.status === 'unavailable'));
}));
