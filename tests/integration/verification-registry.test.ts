import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { codexFixture } from '../fixtures/codex.js';
import { profileFixture } from '../fixtures/verification-profile.js';
import { repositoryActor as actor } from '../fixtures/repository.js';
import { historicalDatabase, copyHistoricalFixture } from '../fixtures/historical-database.js';
import { openOrchestrationDatabase, currentSchemaVersion } from '../../packages/persistence/src/migrations.js';
import { validateVerificationProfile } from '../../packages/shared/src/verification-profile.js';
const claim = (f: Awaited<ReturnType<typeof codexFixture>>) => f.repository.queue.claim({ ownerId: 'owner', workerKind: 'codex', leaseMs: 10000 }, actor)!;
test('profiles freeze exact gates and missing bindings cannot be upgraded mid-attempt', async () => {
  const f = await codexFixture(); const db = new DatabaseSync(f.filename);
  try {
    const current = claim(f); f.repository.queue.start(current, actor);
    const missing = f.repository.verification.bind(current, actor); assert.equal(missing.profile, undefined);
    const registered = f.repository.verification.register('fixture', profileFixture(), actor, 'Owner approved exact gates');
    assert.equal(f.repository.verification.bind(current, actor).profile, undefined);
    assert.deepEqual(f.repository.verification.register('fixture', profileFixture(), actor, 'Idempotent owner request'), registered);
    const changed = profileFixture(); changed.steps[0].timeoutMs++;
    assert.throws(() => f.repository.verification.register('fixture', changed, actor, 'Attempt mutation'));
    assert.throws(() => db.exec("UPDATE ctx_attempt_profiles SET profile_hash='changed'"));
    f.repository.queue.settle(current, { kind: 'blocked', reason: 'Fixture stopped' }, actor);
    const task = f.repository.getTask('task'); f.repository.queue.controlTask('task', 'retry', task.revision, actor, 'Owner retry'); f.repository.queue.refresh(actor);
    const next = claim(f); assert.equal(f.repository.verification.bind(next, actor).profileHash, registered.hash);
    assert.throws(() => f.repository.verification.bind({ ...next, fencingToken: 99 }, actor));
    f.repository.queue.stopped(next, actor, 'Fixture never launched');
  } finally { db.close(); await f.cleanup(); }
});
test('waivers require profile owner authority and bind one exact future attempt/check', async () => {
  const f = await codexFixture();
  try {
    f.repository.verification.register('fixture', profileFixture(), actor, 'Owner configured profile'); const task = f.repository.getTask('task'); const expiry = new Date(Date.now() + 60000).toISOString();
    assert.throws(() => f.repository.verification.grantWaiver('task', task.revision, 'scanner', 'Wrong principal', expiry, { ...actor, actorId: 'other' }));
    assert.throws(() => f.repository.verification.grantWaiver('task', task.revision, 'scanner', 'Remote principal', expiry, { ...actor, source: 'discord' }));
    assert.throws(() => f.repository.verification.grantWaiver('task', task.revision, 'scope', 'Cannot weaken scope', expiry, actor));
    const waiver = f.repository.verification.grantWaiver('task', task.revision, 'scanner', 'Explicit one-attempt unavailable scanner waiver', expiry, actor);
    const current = claim(f); f.repository.verification.bind(current, actor);
    assert.equal(f.repository.verification.applicableWaiver(current, 'scanner')?.id, waiver.id); assert.equal(f.repository.verification.applicableWaiver({ ...current, attempt: { ...current.attempt, sequence: 2 } }, 'scanner'), undefined);
    assert.throws(() => f.repository.verification.grantWaiver('task', f.repository.getTask('task').revision, 'scanner', 'Too late', expiry, actor));
    f.repository.queue.stopped(current, actor, 'Fixture never launched');
  } finally { await f.cleanup(); }
});
test('profile schema rejects omitted immutable guards, unsupported commands and tests without evidence', () => {
  const profile = profileFixture(); profile.steps.shift(); assert.throws(() => validateVerificationProfile(profile));
  for (const program of ['sh', '../node']) { const candidate = profileFixture(); candidate.steps.push({ id: 'unsafe', kind: 'command', required: true, waivable: false, timeoutMs: 1000, integration: 'live', command: { program, args: [] }, role: 'custom' }); assert.throws(() => validateVerificationProfile(candidate)); }
  const candidate = profileFixture(); candidate.steps.push({ id: 'tests', kind: 'command', role: 'test', required: true, waivable: false, timeoutMs: 1000, integration: 'live', command: { program: 'node', args: ['--test'] } }); assert.throws(() => validateVerificationProfile(candidate));
});
test('schema 6 upgrades without losing historical verification status and artifact references', async () => {
  const f = await codexFixture();
  try {
    const current = claim(f); f.repository.queue.start(current, actor); f.repository.queue.beginVerification(current, actor); f.repository.queue.blockVerificationHandoff(current, actor, { reason: 'Historical pending check' });
    const filename = join(f.root, 'v6.sqlite'); const old = historicalDatabase(filename, 6);
    copyHistoricalFixture(f.filename, old, ['ctx_projects','ctx_tasks','ctx_attempts','ctx_verification_runs','ctx_verification_steps']); old.close();
    const migrated = await openOrchestrationDatabase(filename);
    try {
      assert.equal(migrated.migratedFrom, 6); assert.ok(migrated.backupPath); assert.equal((migrated.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, currentSchemaVersion);
      assert.equal((migrated.db.prepare('SELECT status FROM ctx_verification_steps').get() as { status: string }).status, 'unavailable'); assert.deepEqual(migrated.db.prepare('PRAGMA foreign_key_check').all(), []);
      assert.throws(() => migrated.db.exec("UPDATE ctx_verification_steps SET status='passed'"));
    } finally { migrated.db.close(); }
  } finally { await f.cleanup(); }
});
