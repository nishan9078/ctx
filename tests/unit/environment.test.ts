import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyFailure } from '../../packages/environment/src/failure-classifier.js';
import { sandboxArgs } from '../../packages/environment/src/docker.js';
import { detectEnvironment, validateMock } from '../../packages/environment/src/service-detector.js';
import { resolve } from 'node:path';
for (const [output, kind] of [
  ['DATABASE_URL PostgreSQL ECONNREFUSED 127.0.0.1:5432', 'postgres-unavailable'], ['getaddrinfo ENOTFOUND postgres', 'postgres-unavailable'],
  ["ENOENT: no such file or directory, open '.env'", 'missing-env'], ["Cannot find package 'pg'", 'missing-dependency'],
  ["Cannot find module './local-code.js'", 'unknown'], ["Cannot find module '/app/missing.js'", 'unknown'], ['PAYMENTS_API_KEY is required', 'missing-api-key'],
  ['fetch failed ENOTFOUND mock', 'mock-unavailable'], ['EADDRINUSE', 'port-in-use'], ['Please run playwright install', 'browser-unavailable'], ['Assertion failed', 'unknown'],
] as const) test(`classifies ${kind}: ${output}`, () => assert.equal(classifyFailure(output).kind, kind));
test('Docker sandbox has bounded resources and no host network/socket/credentials', async () => {
  const config = await detectEnvironment(resolve('tests/fixtures/feature'));
  const args = sandboxArgs(config, '/tmp/task/workspace', 'task-network', 'task-check', 'task', 'check', {});
  for (const flag of ['--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--memory=512m', '--cpus=1', '--pids-limit=128']) assert.ok(args.includes(flag));
  assert.equal(args[args.indexOf('--network') + 1], 'task-network'); assert.equal(args[args.indexOf('--pull') + 1], 'never');
  assert.doesNotMatch(args.join(' '), /docker.sock|--privileged|network host|\/home\/.*\.codex/);
});
test('detects explicit disposable PostgreSQL and refuses unsafe permissions', async () => {
  const config = await detectEnvironment(resolve('tests/fixtures/postgres'));
  assert.equal(config.services.postgres, true); assert.equal(config.mode, 'docker'); assert.equal(config.allowImagePull, false);
  await assert.rejects(detectEnvironment(resolve('tests/fixtures/postgres'), { mode: 'host' }), /require Docker/);
  await assert.rejects(detectEnvironment(resolve('tests/fixtures/feature'), { maxRecoveryAttempts: -1 }), /budget/);
});
test('mock contracts cannot inject code or sensitive process settings', () => {
  assert.throws(() => validateMock({ urlVariable: 'NODE_OPTIONS', routes: [] }));
  assert.throws(() => validateMock({ urlVariable: 'DATABASE_URL', routes: [{ method: 'GET', path: '/', status: 200, body: {} }] }));
  assert.throws(() => validateMock({ urlVariable: 'MOCK_API_URL', routes: [{ method: 'GET', path: '/__harness_health', status: 200, body: {} }] }));
  assert.equal(validateMock({ urlVariable: 'PAYMENTS_API_URL', routes: [{ method: 'POST', path: '/pay', status: 201, body: { ok: true } }] }).routes[0].status, 201);
});
