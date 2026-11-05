import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodexSecurityAdapter, securityEnvironment } from '../../packages/security/src/codex-security.adapter.js';
test('security worker receives provider/runtime context without unrelated credentials or injection settings', () => {
  const env = securityEnvironment({ HOME: '/home/user', PATH: '/bin', CODEX_API_KEY: 'selected', CODEX_SANDBOX_NETWORK_DISABLED: '1', HTTPS_PROXY: 'http://proxy', AWS_SECRET_ACCESS_KEY: 'unrelated', GITHUB_TOKEN: 'unrelated', DATABASE_URL: 'private', NODE_OPTIONS: '--require=/bad', LD_PRELOAD: '/bad' });
  assert.deepEqual(env, { HOME: '/home/user', PATH: '/bin', CODEX_API_KEY: 'selected', CODEX_SANDBOX_NETWORK_DISABLED: '1', HTTPS_PROXY: 'http://proxy' });
});
test('security adapter accepts valid results and forwards only normalized progress', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ctx-security-test-')); const messages: string[] = [];
  try {
    const adapter = new CodexSecurityAdapter(async (_command, args, _cwd, options) => {
      assert.ok(args[0].endsWith('worker.js')); assert.equal(args[3], '1'); assert.equal(args[4], 'working-tree');
      options?.onOutput?.('CTX_SECURITY_PRO'); options?.onOutput?.('GRESS {"message":"Reviewing source"}\n');
      await writeFile(join(root, 'security-result.json'), JSON.stringify({ status: 'findings', findings: [{ id: 'one', title: 'Unsafe query', severity: 'high', file: 'db.js', line: 3 }], coverage: ['db.js'], limitations: [] }));
      return { code: 0, output: '', timedOut: false, truncated: false };
    });
    const result = await adapter.scan({ repositoryPath: root, outputDirectory: root, changesOnly: true, onProgress: message => messages.push(message) });
    assert.equal(result.status, 'findings'); assert.equal(result.findings[0].severity, 'high'); assert.deepEqual(messages, ['Reviewing source']);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('invalid or interrupted security results cannot become passing coverage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ctx-security-test-'));
  try {
    const malformed = new CodexSecurityAdapter(async () => {
      await writeFile(join(root, 'security-result.json'), JSON.stringify({ status: 'passed', findings: [{ title: 'Unvalidated' }], coverage: [], limitations: [] }));
      return { code: 0, output: '', timedOut: false, truncated: false };
    });
    assert.notEqual((await malformed.scan({ repositoryPath: root, outputDirectory: root })).status, 'passed');
    const timeout = new CodexSecurityAdapter(async () => ({ code: null, output: '', timedOut: true, truncated: false }));
    assert.equal((await timeout.scan({ repositoryPath: root, outputDirectory: root })).status, 'error');
    const aborted = await timeout.scan({ repositoryPath: root, outputDirectory: root, signal: AbortSignal.abort() });
    assert.equal(aborted.status, 'cancelled');
  } finally { await rm(root, { recursive: true, force: true }); }
});
