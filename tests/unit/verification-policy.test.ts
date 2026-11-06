import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVerificationPolicy, inferAcceptance, validateAcceptance } from '../../packages/verification/src/policy.js';
test('task-aware criteria are conservative and cannot bypass required security/application checks', () => {
  assert.deepEqual(inferAcceptance('hello can you make a folder'), [{ kind: 'directory', path: 'new-folder' }]);
  assert.equal(inferAcceptance('Create a folder and implement an API'), undefined);
  assert.throws(() => validateAcceptance([{ kind: 'directory', path: '../escape' }]), /safe/);
  assert.throws(() => validateAcceptance([{ kind: 'file', path: '.git/config' }]), /safe/);
  assert.throws(() => validateAcceptance([]));
  assert.ok(createVerificationPolicy('Change authentication', { test: 'true' }).required.includes('security'));
  assert.deepEqual(createVerificationPolicy('Create folder demo', {}, undefined, ['test']).required, ['test']);
});

import { mkdtemp, writeFile, mkdir, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { verifyAcceptance } from '../../packages/verification/src/policy.js';
import { LocalDockerDriver } from '../../packages/environment/src/docker.js';
import { DockerEnvironmentError } from '../../packages/environment/src/docker-diagnostics.js';
test('filesystem verification rejects symlink escapes and documentation checks require valid local links', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ctx-policy-')); const workspace = join(root, 'work'); await mkdir(workspace);
  try {
    await writeFile(join(root, 'outside.txt'), 'private'); await symlink(join(root, 'outside.txt'), join(workspace, 'link.txt'));
    assert.equal((await verifyAcceptance(workspace, [{ kind: 'file', path: 'link.txt' }])).passed, false);
    await writeFile(join(workspace, 'README.md'), '[missing](missing.md)'); assert.equal((await verifyAcceptance(workspace, [{ kind: 'markdown', path: 'README.md' }])).passed, false);
    await writeFile(join(workspace, 'README.md'), '[docs](https://example.com/docs)'); const result = await verifyAcceptance(workspace, [{ kind: 'markdown', path: 'README.md' }]); assert.equal(result.passed, true); assert.match(result.output, /reachability is unverified/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('a missing daemon is distinct from socket permission denial', async () => {
  const driver = new LocalDockerDriver(async () => ({ code: 1, output: 'Cannot connect to the Docker daemon', timedOut: false, truncated: false }));
  await assert.rejects(driver.command(['info']), error => error instanceof DockerEnvironmentError && error.diagnostic.kind === 'daemon-unavailable' && /explicitly select/.test(error.diagnostic.recommendation));
});

import { syntaxEnvironment } from '../../packages/verification/src/checks.js';
test('trusted syntax parsers do not inherit application preload hooks or credentials', () => {
  assert.deepEqual(syntaxEnvironment({ PATH: '/bin', LANG: 'C.UTF-8', NODE_OPTIONS: '--require ./app.js', NODE_PATH: '/app', LD_PRELOAD: '/app/inject.so', PYTHONPATH: '/app', OPENAI_API_KEY: 'private', CODEX_SANDBOX_NETWORK_DISABLED: '1' }), { PATH: '/bin', LANG: 'C.UTF-8', CODEX_SANDBOX_NETWORK_DISABLED: '1' });
});
