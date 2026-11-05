import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { runTask } from '../../packages/core/src/orchestrator.js';
import { CodexSdkAdapter } from '../../packages/agents/src/codex-sdk.adapter.js';
test('LIVE: Codex implements a fixture feature and harness captures diff plus test results', { skip: process.env.HARNESS_LIVE !== '1', timeout: 240_000 }, async () => {
  const { report, directory } = await runTask({
    request: 'Add export function farewell(name) returning `Goodbye, ${name}!` to index.js. Add a test for farewell to index.test.js. Keep greet working.',
    repositoryPath: resolve('tests/fixtures/feature'), outputDirectory: resolve('.harness/live'), timeoutMs: 180_000,
  }, new CodexSdkAdapter());
  console.log(`Live evidence: ${directory}`);
  assert.equal(report.outcome, 'completed', report.implemented.summary);
  assert.equal(report.implemented.hasChanges, true);
  assert.match(await readFile(report.implemented.diff, 'utf8'), /farewell/);
  assert.ok(report.verification.every(check => check.status === 'passed'));
  const testLog = await readFile(join(directory, 'test.log'), 'utf8');
  assert.doesNotMatch(testLog, /skipping running files/);
  assert.match(testLog, /pass 2/);
});
