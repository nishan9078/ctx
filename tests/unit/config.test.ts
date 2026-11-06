import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateConfig, resolveProjectConfig, projectConfigDiagnostics } from '../../packages/core/src/config.js';
import { CtxError, ValidationError } from '../../packages/shared/src/errors.js';
import { redactForDiagnostics } from '../../packages/shared/src/redact.js';

test('config defaults are conservative; supported environment overrides win without mutating input', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ctx-config-'));
  try {
    const input = { schemaVersion: 1, projects: [{ id: 'fixture', repositoryPath: root, verificationProfile: 'node-api', commands: { test: 'node --test' } }], security: { allowRepositories: [root] }, runtime: { maxAttemptWallMinutes: 60 } };
    const before = structuredClone(input);
    const result = await resolveProjectConfig(input, 'fixture', { CTX_MAX_WORKERS: '2', CTX_MAX_ATTEMPT_WALL_MINUTES: '45', CTX_ALLOW_REPOSITORIES: '/etc', DISCORD_TOKEN: 'private-secret' });
    assert.equal(result.config.runtime.maxWorkers, 2); assert.equal(result.config.runtime.maxAttemptWallMinutes, 45); assert.equal(result.config.runtime.maxWorkersPerProject, 1);
    assert.equal(result.config.capacity.probePaidEndpoints, false); assert.equal(result.config.notifications.discord, false);
    assert.equal(result.config.security.defaultNetwork, 'restricted'); assert.ok(result.config.security.requireApproval.includes('deployment'));
    assert.deepEqual(result.config.security.allowRepositories, [root]); assert.deepEqual(result.project.commands, { test: 'node --test' });
    result.project.commands.test = 'test --token private-secret';
    assert.ok(!JSON.stringify(projectConfigDiagnostics(result, { DISCORD_TOKEN: 'private-secret' })).includes('private-secret'));
    result.project.commands.test = 'node --test';
    assert.ok(!JSON.stringify(result).includes('private-secret')); assert.deepEqual(input, before);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('registration and exact canonical allowlist reject child paths and unregistered projects', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ctx-config-path-'));
  try {
    const child = join(root, 'child'); const alias = join(root, 'alias'); await mkdir(child); await symlink(child, alias);
    const input = { schemaVersion: 1, projects: [{ id: 'fixture', repositoryPath: alias, verificationProfile: 'node-api' }], security: { allowRepositories: [root] } };
    await assert.rejects(resolveProjectConfig(input, 'fixture', {}), error => error instanceof CtxError && error.code === 'UNAUTHORIZED');
    await assert.rejects(resolveProjectConfig(input, 'unknown', {}), error => error instanceof CtxError && error.code === 'UNAUTHORIZED');
    input.security.allowRepositories = [child];
    assert.equal((await resolveProjectConfig(input, 'fixture', {})).project.repositoryPath, child);
  } finally { await rm(root, { recursive: true, force: true }); }
});
for (const [name, patch] of [
  ['bad version', { schemaVersion: 2 }], ['null section', { runtime: null }], ['null scalar', { runtime: { maxWorkers: null } }], ['sparse projects', { projects: new Array(1) }], ['secret field', { discordToken: 'must-not-leak' }], ['too many workers', { runtime: { maxWorkers: 3 } }],
  ['project concurrency', { runtime: { maxWorkers: 1, maxWorkersPerProject: 2 } }], ['unsafe network', { security: { defaultNetwork: 'unrestricted' } }], ['string boolean', { capacity: { probePaidEndpoints: 'true' } }], ['sparse backoff', { capacity: { unknownLimitBackoffSeconds: new Array(1) } }], ['bad backoff', { capacity: { unknownLimitBackoffSeconds: [60, 20] } }],
  ['relative repo', { projects: [{ id: 'project', repositoryPath: '../repo', verificationProfile: 'node' }] }], ['duplicate IDs', { projects: [1, 2].map(() => ({ id: 'same', repositoryPath: '/tmp', verificationProfile: 'node' })) }],
] as const) test(`config rejects ${name}`, () => assert.throws(() => validateConfig(Object.assign({ schemaVersion: 1, projects: [] }, patch)), ValidationError));
test('invalid environment numbers fail before repository access and never echo values', async () => {
  for (const value of ['0', '3', '1.5', 'Infinity', 'fixture-secret', ' 1']) {
    await assert.rejects(resolveProjectConfig({ schemaVersion: 1, projects: [] }, 'missing', { CTX_MAX_WORKERS: value }), error => error instanceof ValidationError && !error.message.includes('fixture-secret'));
  }
});
test('structured diagnostics redact nested credentials, known secret values, and URL userinfo', () => {
  const value = { password: 'short', nested: [{ authorization: 'Bearer secret', command: 'send opaque-value' }], endpoint: 'postgres://alice:private@localhost/db', api_key: 'key', safe: 1 };
  const result = JSON.stringify(redactForDiagnostics(value, { SERVICE_TOKEN: 'opaque-value' }));
  for (const secret of ['short', 'Bearer secret', 'opaque-value', 'alice:private']) assert.ok(!result.includes(secret));
  assert.equal(value.password, 'short'); assert.match(result, /REDACTED/); assert.match(result, /"safe":1/);
  const cycle: { self?: unknown } = {}; cycle.self = cycle; assert.doesNotThrow(() => JSON.stringify(redactForDiagnostics(cycle)));
});
