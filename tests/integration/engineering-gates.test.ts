import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { engineeringFixture, controlledEngineeringWorker, readyProbe } from '../fixtures/engineering.js';
import { createCodexQueueScheduler } from '../../packages/core/src/codex-queue-worker.js';
import { repositoryActor as actor } from '../fixtures/repository.js';
import { liveProcessGroup } from '../../packages/environment/src/process-group.js';

test('ordinary completion requires exactly the approved TypeScript/test/build/lint/security gates and retained commit evidence', async () => {
  const f = await engineeringFixture(); const scheduler = createCodexQueueScheduler(f.repository, { probe: readyProbe, executor: controlledEngineeringWorker() });
  try {
    const status = await scheduler.runUntilIdle({ timeoutMs: 60000 }); assert.equal(status.completed, 1, f.repository.getTask('task').reason); assert.equal(scheduler.lastError, undefined);
    const report = await f.report(); assert.equal(report.status, 'passed'); assert.deepEqual(report.steps.map(step => step.id), f.profile.steps.map(step => step.id));
    for (const step of report.steps.filter(step => step.required)) assert.equal(step.status, 'passed', step.id);
    assert.equal(report.steps.find(step => step.id === 'codex_security')!.status, 'unavailable'); assert.ok(report.resultSha); assert.notEqual(report.baseSha, report.resultSha);
    assert.match(await readFile(join(f.project, 'src/app.ts'), 'utf8'), /return 0/); assert.ok(report.artifactIds.length > 20);
    for (const id of report.artifactIds) await f.repository.verifyStoredArtifact(id);
    for (const process of f.repository.verification.processes(report.attemptId)) assert.deepEqual(liveProcessGroup(process.pgid), []);
    const outputDirectory = join(f.repository.dataDirectory, 'verification', report.attemptId, report.id);
    assert.equal(JSON.parse(await readFile(join(outputDirectory, 'report.json'), 'utf8')).id, report.id); assert.match(await readFile(join(outputDirectory, 'REPORT.md'), 'utf8'), /Verification: \*\*passed\*\*/);
  } finally { await scheduler.shutdown(); await f.cleanup(); }
});
for (const mode of ['typecheck','tests','build','secrets','omitted','scope'] as const) test(`agent says done but ${mode} failure prevents completion`, async () => {
  const f = await engineeringFixture(profile => { if (mode === 'build') profile.steps.find(step => step.id === 'build')!.command!.args = ['build-fail.cjs']; });
  const worker = controlledEngineeringWorker(async workspace => {
    if (mode === 'typecheck') await writeFile(join(workspace, 'src/app.ts'), 'export function add(a: number,b: number): number { return "wrong"; }');
    if (mode === 'tests') await writeFile(join(workspace, 'src/app.ts'), 'export function add(a: number,b: number): number { return a - b; }');
    if (mode === 'secrets') await writeFile(join(workspace, 'src/leak.txt'), ['sk-', 'q'.repeat(40)].join(''));
    if (mode === 'omitted') await writeFile(join(workspace, 'tests/app.test.cjs'), 'const {test}=require("node:test");test.skip("silently omitted",()=>{});');
    if (mode === 'scope') { await mkdir(join(workspace, 'infra')); await writeFile(join(workspace, 'infra/unapproved.json'), '{}'); }
  });
  const scheduler = createCodexQueueScheduler(f.repository, { probe: readyProbe, executor: worker });
  try {
    const status = await scheduler.runUntilIdle({ timeoutMs: 60000 }); assert.equal(status.completed, 0); assert.equal(f.repository.getTask('task').state, 'failed');
    const report = await f.report(); assert.equal(report.status, 'failed'); const expected = mode === 'omitted' ? 'integrity' : mode;
    assert.equal(report.steps.find(step => step.id === expected)!.status, 'failed');
    if (mode === 'omitted') assert.equal(report.steps.find(step => step.id === 'tests')!.status, 'failed');
    if (mode === 'secrets') { assert.ok(report.steps.find(step => step.id === 'secrets')!.findings[0].fingerprint); assert.ok(!JSON.stringify(report).includes('q'.repeat(40))); }
  } finally { await scheduler.shutdown(); await f.cleanup(); }
});
test('required unavailable scanner blocks despite passing independent fallback checks', async () => {
  const f = await engineeringFixture(profile => { profile.steps.find(step => step.id === 'codex_security')!.required = true; });
  const scheduler = createCodexQueueScheduler(f.repository, { probe: readyProbe, executor: controlledEngineeringWorker() });
  try {
    const status = await scheduler.runUntilIdle({ timeoutMs: 60000 }); assert.equal(status.blocked, 1); const report = await f.report(); assert.equal(report.status, 'unavailable');
    assert.equal(report.steps.find(step => step.id === 'codex_security')!.status, 'unavailable'); assert.equal(report.steps.find(step => step.id === 'secrets')!.status, 'passed');
  } finally { await scheduler.shutdown(); await f.cleanup(); }
});
test('exact owner waiver is visible and consumed without rewriting unavailable coverage as passed', async () => {
  const f = await engineeringFixture(profile => { profile.steps.find(step => step.id === 'codex_security')!.required = true; });
  const task = f.repository.getTask('task'); const waiver = f.repository.verification.grantWaiver('task', task.revision, 'codex_security', 'Owner explicitly accepts unavailable optional service for this one attempt', new Date(Date.now() + 600000).toISOString(), actor);
  const scheduler = createCodexQueueScheduler(f.repository, { probe: readyProbe, executor: controlledEngineeringWorker() });
  try {
    assert.equal((await scheduler.runUntilIdle({ timeoutMs: 60000 })).completed, 1); const report = await f.report(); assert.equal(report.status, 'passed_with_waivers');
    const scan = report.steps.find(step => step.id === 'codex_security')!; assert.equal(scan.status, 'skipped_with_approval'); assert.equal(scan.observedStatus, 'unavailable'); assert.equal(scan.waiverId, waiver.id);
    assert.equal(f.repository.verification.waivers('task')[0].usedByAttempt, report.attemptId);
  } finally { await scheduler.shutdown(); await f.cleanup(); }
});
test('mock-only project commands never satisfy required live gates', async () => {
  const f = await engineeringFixture();
  const scheduler = createCodexQueueScheduler(f.repository, { probe: readyProbe, executor: controlledEngineeringWorker(), verification: { backend: { kind: 'mock', async run() { return { code: 0, timedOut: false, truncated: false, output: '# tests 1\n# pass 1\n# fail 0\n# skipped 0\n' }; } } } });
  try {
    assert.equal((await scheduler.runUntilIdle({ timeoutMs: 60000 })).blocked, 1); const report = await f.report(); assert.equal(report.status, 'mock_verified');
    assert.equal(report.steps.find(step => step.id === 'tests')!.status, 'mock_verified'); assert.match(JSON.stringify(report), /live integration was not tested/i);
  } finally { await scheduler.shutdown(); await f.cleanup(); }
});
test('per-step timeout stops its owned process and cannot become a passing gate', async () => {
  const f = await engineeringFixture(profile => { const lint = profile.steps.find(step => step.id === 'lint')!; lint.command!.args = ['slow.cjs']; lint.timeoutMs = 100; });
  const scheduler = createCodexQueueScheduler(f.repository, { probe: readyProbe, executor: controlledEngineeringWorker() });
  try {
    assert.equal((await scheduler.runUntilIdle({ timeoutMs: 60000 })).failed, 1); const report = await f.report(); const lint = report.steps.find(step => step.id === 'lint')!;
    assert.equal(lint.status, 'failed'); assert.equal(lint.timedOut, true); for (const process of f.repository.verification.processes(report.attemptId)) assert.deepEqual(liveProcessGroup(process.pgid), []);
  } finally { await scheduler.shutdown(); await f.cleanup(); }
});

test('unavailable approved container backend is blocked without executing project commands on the host', async () => {
  const f = await engineeringFixture(profile => { profile.backend = 'docker'; });
  const scheduler = createCodexQueueScheduler(f.repository, { probe: readyProbe, executor: controlledEngineeringWorker() });
  try {
    assert.equal((await scheduler.runUntilIdle({ timeoutMs: 60000 })).blocked, 1); const report = await f.report();
    for (const step of report.steps.filter(step => step.command)) { assert.equal(step.status, 'unavailable'); assert.equal(step.environment.backend, 'none'); }
    assert.equal(f.repository.verification.processes(report.attemptId).some(process => process.pgid <= 0), false);
  } finally { await scheduler.shutdown(); await f.cleanup(); }
});

test('a successful verifier that changes deliverable source fails the final independent guards', async () => {
  const f = await engineeringFixture(profile => { profile.steps.find(step => step.id === 'lint')!.command!.args = ['-e', 'require("node:fs").writeFileSync("src/app.ts","export function add(a: number,b: number): number { return 0; }")']; });
  const scheduler = createCodexQueueScheduler(f.repository, { probe: readyProbe, executor: controlledEngineeringWorker() });
  try {
    assert.equal((await scheduler.runUntilIdle({ timeoutMs: 60000 })).failed, 1); const report = await f.report();
    assert.equal(report.steps.find(step => step.id === 'lint')!.status, 'passed');
    assert.ok(report.steps.find(step => step.id === 'scope')!.findings.some(finding => finding.scanner === 'ctx-source-stability'));
  } finally { await scheduler.shutdown(); await f.cleanup(); }
});
