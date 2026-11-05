import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runProcess } from '../../packages/environment/src/process-manager.js';

test('subprocesses inherit actual identity/groups and explicit Docker environment without test-runner leakage', async () => {
  const env = { ...process.env, DOCKER_HOST: 'unix:///fixture/docker.sock', DOCKER_CONTEXT: 'fixture-context', DOCKER_CONFIG: '/fixture/config', NODE_TEST_CONTEXT: 'must-not-leak' };
  const result = await runProcess(process.execPath, ['-e', `console.log(JSON.stringify({ uid: process.getuid?.(), gid: process.getgid?.(), groups: process.getgroups?.(), host: process.env.DOCKER_HOST, context: process.env.DOCKER_CONTEXT, config: process.env.DOCKER_CONFIG, testContext: process.env.NODE_TEST_CONTEXT ?? null }))`], process.cwd(), { env });
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(JSON.parse(result.output), {
    uid: process.getuid?.(), gid: process.getgid?.(), groups: process.getgroups?.(),
    host: env.DOCKER_HOST, context: env.DOCKER_CONTEXT, config: env.DOCKER_CONFIG, testContext: null,
  });
  assert.equal(env.NODE_TEST_CONTEXT, 'must-not-leak');
});
