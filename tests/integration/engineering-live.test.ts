import { requiredChecksPass } from '../../packages/verification/src/execute-plan.js';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { runTask } from '../../packages/core/src/orchestrator.js';
import { CodexSdkAdapter } from '../../packages/agents/src/codex-sdk.adapter.js';

test('LIVE engineering: real Codex creates a directory and exact file; deterministic acceptance and lifecycle are retained', { skip: process.env.HARNESS_LIVE !== '1', timeout: 240_000 }, async () => {
  const source = await mkdtemp(join(tmpdir(), 'ctx-real-filesystem-')); await writeFile(join(source, 'package.json'), '{"name":"ctx-disposable","private":true}');
  const result = await runTask({ repositoryPath: source, outputDirectory: resolve('.harness/engineering-live'), environment: { mode: 'auto' }, timeoutMs: 180_000,
    request: 'Create a folder named artifacts and create artifacts/message.txt containing exactly CTX works followed by a newline. Use a tool to actually create these on disk. Do not add other files.',
    acceptance: [{ kind: 'directory', path: 'artifacts' }, { kind: 'content', path: 'artifacts/message.txt', content: 'CTX works\n', match: 'exact' }],
  }, new CodexSdkAdapter());
  console.log(`Real Codex evidence: ${result.directory}`);
  assert.equal(result.report.outcome, 'completed', JSON.stringify(result.report));
  assert.equal(result.report.environment.execution, 'filesystem');
  assert.equal(result.report.execution?.codexStarted, true);
  assert.equal(await readFile(join(result.report.workspacePath!, 'artifacts/message.txt'), 'utf8'), 'CTX works\n');
  assert.ok((await stat(join(result.report.workspacePath!, 'artifacts'))).isDirectory());
  await assert.rejects(stat(join(source, 'artifacts')), /ENOENT/);
  const events = (await readFile(join(result.directory, 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  for (const type of ['codex.session.started', 'codex.turn.started', 'codex.tool.started', 'codex.tool.completed', 'codex.turn.completed', 'verification.started', 'verification.completed']) assert.ok(events.some(event => event.type === type), `Missing ${type}`);
  assert.match(await readFile(result.report.implemented.diff, 'utf8'), /message.txt/);
});

test('LIVE engineering: real Codex fixes TypeScript and independent compilation and tests pass', { skip: process.env.HARNESS_LIVE !== '1', timeout: 240_000 }, async () => {
  const source = await mkdtemp(join(tmpdir(), 'ctx-real-typescript-'));
  await writeFile(join(source, 'package.json'), JSON.stringify({ type: 'module', scripts: { build: `"${process.execPath}" "${createRequire(import.meta.url).resolve('typescript/bin/tsc')}" --target ES2022 --module NodeNext --moduleResolution NodeNext --outDir build math.ts`, test: 'node --test math.test.mjs' } }));
  await writeFile(join(source, '.gitignore'), 'build/\n');
  await writeFile(join(source, 'math.ts'), 'export function add(a: number, b: number): number { return a - b; }\n');
  await writeFile(join(source, 'math.test.mjs'), 'import {test} from "node:test"; import assert from "node:assert/strict"; import {add} from "./build/math.js"; test("sum",()=>assert.equal(add(2,3),5));');
  const result = await runTask({ repositoryPath: source, outputDirectory: resolve('.harness/engineering-live'), environment: { mode: 'host' }, timeoutMs: 180_000,
    request: 'Fix add in math.ts so it returns the sum of its numeric arguments. Keep the existing test unchanged and run it. Actually edit the file with a tool.',
  }, new CodexSdkAdapter());
  console.log(`Real TypeScript evidence: ${result.directory}`);
  assert.equal(result.report.outcome, 'completed', JSON.stringify(result.report)); assert.equal(result.report.execution?.codexStarted, true);
  assert.deepEqual(result.report.verification.filter(check => ['build', 'test'].includes(check.name)).map(check => [check.name, check.status]), [['build', 'passed'], ['test', 'passed']]);
  assert.match(await readFile(result.report.implemented.diff, 'utf8'), /math.ts/);
  assert.match(await readFile(join(source, 'math.ts'), 'utf8'), /return a - b/);
});
