import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { runTask } from '../../packages/core/src/orchestrator.js';
import { LocalDockerDriver } from '../../packages/environment/src/docker.js';
test('LIVE DOCKER: initially unavailable DB recovers using real disposable PostgreSQL, migrates, and passes tests', { skip: process.env.HARNESS_DOCKER !== '1', timeout: 240_000 }, async () => {
  const docker = new LocalDockerDriver();
  const { report, directory } = await runTask({ request: 'Verify application against disposable PostgreSQL', repositoryPath: resolve('tests/fixtures/postgres'), outputDirectory: resolve('.harness/docker-live'), timeoutMs: 180_000,
    environment: { allowImagePull: process.env.HARNESS_ALLOW_IMAGE_PULL === '1' },
  }, { async execute() { return { outcome: 'completed', summary: 'Fixture application already supplied; no coding changes requested.' }; } }, { docker });
  console.log(`Docker acceptance evidence: ${directory}`);
  assert.equal(report.outcome, 'completed', `${report.implemented.summary}\nEvidence: ${directory}`);
  assert.equal(report.environment.execution, 'docker'); assert.equal(report.environment.cleanupErrors?.length, 0);
  assert.equal(report.environment.recoveries?.[0].kind, 'postgres-unavailable'); assert.equal(report.environment.recoveries?.[0].status, 'passed');
  assert.match(await readFile(join(directory, 'test.log'), 'utf8'), /ENOTFOUND|ECONNREFUSED/);
  assert.match(await readFile(report.verification[1].artifact, 'utf8'), /# pass 1/);
  for (const args of [['container', 'ls', '--all', '--quiet'], ['network', 'ls', '--quiet']]) {
    const remaining = await docker.command([...args, '--filter', `label=harness.task=${report.id}`]);
    assert.equal(remaining.code, 0, remaining.output);
    assert.equal(remaining.output.trim(), '', `Task resources survived cleanup: ${remaining.output}`);
  }
});
