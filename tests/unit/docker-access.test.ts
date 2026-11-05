import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyDockerAccess, isDockerAccessDenied, type DockerAccessFacts } from '../../packages/environment/src/docker-diagnostics.js';
import { LocalDockerDriver } from '../../packages/environment/src/docker.js';

const facts: DockerAccessFacts = {
  uid: 1000, gid: 1000, groups: [27, 1000], username: 'fixture-user', userNamespaceRestricted: false,
  socket: { path: '/var/run/docker.sock', uid: 0, gid: 973, mode: 0o660, group: 'docker', configuredMember: true },
};
test('detects configured group membership missing from the running session', () => {
  const diagnostic = classifyDockerAccess(facts, 'info');
  assert.equal(diagnostic.kind, 'stale-session-groups');
  assert.match(diagnostic.recommendation, /already configured.*GID 973/);
  assert.match(diagnostic.recommendation, /fully restart the terminal\/Codex runner/);
  assert.match(diagnostic.recommendation, /No socket permission change is needed/);
});
test('does not mistake sandbox restrictions, ACL failures, or missing account membership for stale groups', () => {
  for (const candidate of [
    { ...facts, userNamespaceRestricted: true },
    { ...facts, groups: [1000, 973] },
    { ...facts, gid: 973 },
    { ...facts, socket: { ...facts.socket!, configuredMember: false } },
    { ...facts, socket: { ...facts.socket!, uid: 1000, mode: 0o600 } },
  ]) assert.equal(classifyDockerAccess(candidate, 'info').kind, 'socket-permission-denied');
  assert.match(classifyDockerAccess({ ...facts, userNamespaceRestricted: true }, 'info').recommendation, /explicitly authorized execution context/);
});
test('only recognizes Docker access failures, not generic application permission errors', () => {
  assert.equal(isDockerAccessDenied('permission denied while trying to connect to the docker API at unix:///var/run/docker.sock'), true);
  assert.equal(isDockerAccessDenied('EACCES: permission denied opening /workspace/file'), false);
  assert.equal(isDockerAccessDenied('No such image: node:22-bookworm-slim'), false);
});
test('Docker preserves selected environment across all commands without requesting different credentials', async () => {
  const environment: NodeJS.ProcessEnv = {
    PATH: '/fixture/bin', DOCKER_HOST: 'unix:///fixture/docker.sock', DOCKER_CONTEXT: 'fixture-context',
    DOCKER_CONFIG: '/fixture/docker-config', DOCKER_TLS_VERIFY: '1', DOCKER_CERT_PATH: '/fixture/certs',
    HTTPS_PROXY: 'http://fixture-proxy:8080',
  };
  const original = { ...environment }; let calls = 0;
  const driver = new LocalDockerDriver(async (command, args, _cwd, options) => {
    assert.equal(command, 'docker'); assert.deepEqual(options?.env, original);
    assert.equal('uid' in (options ?? {}), false); assert.equal('gid' in (options ?? {}), false);
    assert.ok(!args.includes('sudo') && !args.includes('newgrp')); calls++;
    return { code: 0, output: 'ok', timedOut: false, truncated: false };
  }, environment);
  environment.DOCKER_HOST = 'unix:///different-daemon.sock';
  for (const command of [['info'], ['image', 'inspect', 'image'], ['run'], ['exec'], ['container', 'rm', 'owned']]) await driver.command(command);
  assert.equal(calls, 5);
});
