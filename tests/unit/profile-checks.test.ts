import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { pathMatches, scopeCheck, testIntegrityCheck, verifyTestSummary } from '../../packages/verification/src/profile-checks.js';
import { scanSecrets, scanDependencies } from '../../packages/security/src/baseline-scanners.js';
import type { TreeEntry } from '../../packages/environment/src/workspace-tree.js';
import { profileFixture } from '../fixtures/verification-profile.js';
import { taskFixture } from '../fixtures/domain.js';
const file = (path: string, content: string): TreeEntry => ({ path, kind: 'file', mode: 0o644, content: Buffer.from(content).toString('base64'), sha256: createHash('sha256').update(content).digest('hex') });
test('scope uses explicit immutable include/exclude and generated paths without regex injection', () => {
  assert.equal(pathMatches('src/a.ts', 'src/**'), true); assert.equal(pathMatches('dist', 'dist/**'), true); assert.equal(pathMatches('src2/a.ts', 'src'), false); assert.equal(pathMatches('axb', 'a.b'), false);
  const profile = profileFixture(); profile.purpose = 'code'; profile.generatedPaths = ['dist/**'];
  assert.equal(scopeCheck(taskFixture, profile, [], [file('dist/a.js','ok'),file('src/a.ts','ok')]).status, 'passed');
  assert.equal(scopeCheck(taskFixture, profile, [], [file('infra/production/a','bad')]).status, 'failed');
});
test('baseline test/script integrity catches deletion, replacement and omission', () => {
  const before = [file('tests/a.test.js','test("a",()=>{});'),file('package.json','{"scripts":{"test":"node --test"}}')]; const profile = profileFixture();
  assert.equal(testIntegrityCheck(profile, before, before).status, 'passed');
  assert.equal(testIntegrityCheck(profile, before, []).status, 'failed');
  assert.equal(testIntegrityCheck(profile, [], [file('test.cjs','test.skip("x",()=>{});')]).status, 'failed');
  assert.equal(testIntegrityCheck(profile, before, [before[0],file('package.json','{"scripts":{"test":"exit 0"}}')]).status, 'failed');
});
test('independent summaries reject zero tests, skipped tests and missing coverage', () => {
  assert.equal(verifyTestSummary('# tests 2\n# pass 2\n# fail 0\n# skipped 0\n','tap',2).passed,true);
  for (const output of ['', '# tests 0\n# pass 0\n# fail 0\n', '# tests 2\n# pass 1\n# fail 0\n# skipped 1\n']) assert.equal(verifyTestSummary(output,'tap',1).passed,false);
  assert.equal(verifyTestSummary('3 passed in 0.1s','pytest',2).passed,true); assert.equal(verifyTestSummary('3 passed, 1 skipped','pytest',2).passed,false);
});
test('secret baseline emits only redacted finding metadata and fingerprints', () => {
  const secret = ['sk-', 'r'.repeat(40)].join(''); const result = scanSecrets([file('src/key.txt',secret)], {});
  assert.equal(result.status,'failed'); assert.equal(result.findings[0].severity,'high'); assert.ok(result.findings[0].fingerprint); assert.ok(!JSON.stringify(result).includes(secret));
});
test('dependency baseline distinguishes unknown coverage from a real exact advisory finding', () => {
  assert.equal(scanDependencies([file('package.json','{"dependencies":{"bad-lib":"1.0.0"}}')],undefined).status,'unavailable');
  assert.equal(scanDependencies([file('packages/a/package.json','{"dependencies":{"bad-lib":"1.0.0"}}')],undefined).status,'unavailable');
  assert.equal(scanDependencies([file('package.json','{"dependencies":[]}')],undefined).status,'failed');
  const entries = [file('package.json','{"dependencies":{"bad-lib":"1.0.0"}}'),file('package-lock.json','{"packages":{"node_modules/bad-lib":{"version":"1.0.0"}}}')];
  const result = scanDependencies(entries,{ source:'controlled fixture database, not a real advisory feed',asOf:'2026-11-07',entries:[{id:'fixture-vuln',name:'bad-lib',version:'1.0.0',severity:'high'}]});
  assert.equal(result.status,'failed'); assert.equal(result.findings[0].id,'fixture-vuln');
  assert.equal(scanDependencies([file('package.json','{"dependencies":{}}')],undefined).status,'passed');
});

test('exact configured gates are required even for interrupted or failed harness reports', async () => {
  const { gateReportStatus } = await import('../../packages/shared/src/verification-profile.js');
  for (const outcome of ['completed','failed','interrupted'] as const) assert.throws(() => gateReportStatus(profileFixture(), [], outcome), /exactly the configured checks/);
});
