import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeCodex, type ProbeCommandResult } from '../../packages/agents/src/codex-probe.js';

const runner = (result: ProbeCommandResult) => async () => result;

test('probe reports CLI and SDK versions and auth-file presence without values', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-home-'));
  await import('node:fs/promises').then(fs => fs.writeFile(join(home, 'auth.json'), '{"tokens":{"id_token":"secret-value"}}'));
  const readiness = await probeCodex({
    env: {}, homeDir: home, sdkVersion: '0.166.0',
    run: runner({ code: 0, output: 'codex-cli 0.166.0\n' }),
  });
  assert.equal(readiness.sdkVersion, '0.166.0');
  assert.equal(readiness.cliVersion, 'codex-cli 0.166.0');
  assert.equal(readiness.cliAvailable, true);
  assert.equal(readiness.auth, 'auth-file');
  assert.equal(readiness.model, 'unknown');
  assert.equal(readiness.provider, 'unknown');
  assert.ok(!JSON.stringify(readiness).includes('secret-value'));
  assert.deepEqual(readiness.probeErrors, []);
});

test('probe reports env credentials and missing CLI without running a generation', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-home-'));
  const readiness = await probeCodex({
    env: { CODEX_API_KEY: 'key-value' }, homeDir: home, sdkVersion: '0.166.0',
    run: runner({ code: null, output: '', error: 'CLI executable not found in PATH' }),
  });
  assert.equal(readiness.cliAvailable, false);
  assert.equal(readiness.auth, 'env');
  assert.ok(!JSON.stringify(readiness).includes('key-value'));
  assert.ok(readiness.probeErrors.some(message => message.includes('not found')));
});

test('probe reports no credentials and unknown model/provider', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-home-'));
  const readiness = await probeCodex({
    env: {}, homeDir: home, sdkVersion: 'unknown',
    run: runner({ code: 0, output: 'codex-cli 9.9.9\n' }),
  });
  assert.equal(readiness.auth, 'none');
  assert.equal(readiness.sdkVersion, 'unknown');
  assert.equal(readiness.model, 'unknown');
  assert.ok(readiness.probeErrors.length > 0);
});

test('probe surfaces CLI timeout as an error and stays available=false', async () => {
  const readiness = await probeCodex({ env: {}, sdkVersion: '0.0.0', run: runner({ code: 124, output: '' }) });
  assert.equal(readiness.cliAvailable, false);
  assert.match(readiness.probeErrors[0] ?? '', /codex --version/);
});


test('probe resolves the real ESM SDK package and ignores CLI warnings', async () => {
  const result = await probeCodex({ env: {}, run: runner({ code: 0, output: 'WARNING: unable to create aliases\ncodex-cli 0.166.0\n' }) });
  assert.equal(result.sdkVersion, '0.166.0');
  assert.equal(result.cliVersion, 'codex-cli 0.166.0');
});
