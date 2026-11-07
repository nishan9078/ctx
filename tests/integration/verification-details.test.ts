import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { codexFixture } from '../fixtures/codex.js';
import { profileFixture } from '../fixtures/verification-profile.js';
import { repositoryActor as actor } from '../fixtures/repository.js';
import { readyProbe } from '../fixtures/engineering.js';
import { createCodexQueueScheduler } from '../../packages/core/src/codex-queue-worker.js';
import { reconcileVerificationReports } from '../../packages/core/src/engineering-verification.js';
import { verificationTaskDetails } from '../../packages/core/src/verification-details.js';
import { runOwnedCommand } from '../../packages/environment/src/owned-command.js';

const cli = (args: string[]) => runOwnedCommand(process.execPath, [resolve('dist/apps/cli/src/index.js'), ...args], process.cwd(), { timeoutMs: 15000 });
test('CLI registers immutable owner gates, grants an exact waiver and exposes hash-checked JSON/Markdown evidence', async () => {
  const f = await codexFixture(); let scheduler: ReturnType<typeof createCodexQueueScheduler> | undefined;
  try {
    const profile = profileFixture(); profile.steps.push({ id: 'acceptance', kind: 'acceptance', required: true, waivable: false, timeoutMs: 1000, integration: 'live', criteria: [{ kind: 'content', path: 'src/result.txt', content: 'verified\n', match: 'exact' }] });
    const filename = join(f.root, 'profile.json'); await writeFile(filename, JSON.stringify(profile));
    const registration = await cli(['profile', filename, '--project', 'fixture', '--database', f.filename]); assert.equal(registration.code, 0, registration.output);
    assert.equal(JSON.parse(registration.stdout!).profile.id, profile.id);
    const waiver = await cli(['waive', 'task', '--step', 'scanner', '--revision', String(f.repository.getTask('task').revision), '--reason', 'Explicit one-attempt scanner waiver', '--expires', new Date(Date.now() + 600000).toISOString(), '--database', f.filename]); assert.equal(waiver.code, 0, waiver.output);
    scheduler = createCodexQueueScheduler(f.repository, { probe: readyProbe, executor: { async run(input) {
      await mkdir(join(input.workspacePath, 'src'), { recursive: true }); await writeFile(join(input.workspacePath, 'src/result.txt'), 'verified\n');
      for (const event of [{ type: 'thread.started', thread_id: 'details-fixture' }, { type: 'turn.started' }, { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }]) await input.onRawEvent(event);
      return { exitCode: 0, exitSignal: null, stderrTail: '', stderrTruncated: false, aborted: false, spawned: false };
    } } });
    assert.equal((await scheduler.runUntilIdle({ timeoutMs: 30000 })).completed, 1, scheduler.lastError ?? f.repository.getTask('task').reason);
    const json = await cli(['details', 'task', '--database', f.filename]); assert.equal(json.code, 0, json.output); const details = JSON.parse(json.stdout!);
    assert.equal(details.task.state, 'completed'); assert.equal(details.latestReport.status, 'passed_with_waivers');
    assert.equal(details.latestReport.steps.find((step: { id: string }) => step.id === 'scanner').observedStatus, 'unavailable');
    const markdown = await cli(['details', 'task', '--database', f.filename, '--report-format', 'markdown']); assert.equal(markdown.code, 0, markdown.output); assert.match(markdown.stdout!, /State: completed/); assert.match(markdown.stdout!, /skipped_with_approval/);
    const evidence = await f.repository.verifyStoredArtifact(details.latestReport.steps[0].stdoutArtifactId); await writeFile(join(f.repository.dataDirectory, evidence.location), 'tampered');
    const corrupt = await cli(['details', 'task', '--database', f.filename]); assert.notEqual(corrupt.code, 0); assert.doesNotMatch(corrupt.stdout ?? '', /"state": "completed"/);
  } finally { await scheduler?.shutdown(); await f.cleanup(); }
});

test('stopped attempts recover honest nonpassing reports without replaying checks or inventing historical gates', async () => {
  for (const bind of [false, true]) {
    const f = await codexFixture();
    try {
      f.repository.verification.register('fixture', profileFixture(), actor, 'Exact fixture gates');
      const claim = f.repository.queue.claim({ ownerId: 'owner', workerKind: 'codex', leaseMs: 10000 }, actor)!; f.repository.queue.start(claim, actor);
      if (bind) f.repository.verification.bind(claim, actor);
      assert.equal(await reconcileVerificationReports(f.repository, actor), 0);
      f.repository.queue.stopped(claim, actor, 'Injected controller loss after retained partial work');
      assert.equal(await reconcileVerificationReports(f.repository, actor), 1);
      const details = await verificationTaskDetails(f.repository, 'task'); assert.equal(details.latestReport?.reconciled, true); assert.equal(details.latestReport?.status, 'cancelled');
      assert.equal(details.latestReport?.steps.length, bind ? profileFixture().steps.length : 0);
      for (const step of details.latestReport!.steps) assert.equal(step.observedStatus, 'not_run');
      assert.equal(f.repository.verification.processes(claim.attempt.id).length, 0); assert.notEqual(f.repository.getTask('task').state, 'completed');
      assert.equal(await reconcileVerificationReports(f.repository, actor), 0);
    } finally { await f.cleanup(); }
  }
});

test('completion rechecks evidence and cancellation after a passing report is published', async () => {
  const { CodexQueueWorker } = await import('../../packages/core/src/codex-queue-worker.js');
  const { DurableScheduler } = await import('../../packages/core/src/durable-scheduler.js');
  const { verifyEngineeringAttempt } = await import('../../packages/core/src/engineering-verification.js');
  for (const mode of ['cancel', 'corrupt'] as const) {
    const f = await codexFixture();
    const profile = profileFixture(); profile.steps.find(step => step.id === 'scanner')!.required = false;
    f.repository.verification.register('fixture', profile, actor, 'Owner configured a bounded filesystem profile');
    const scheduler = new DurableScheduler(f.repository, new CodexQueueWorker(f.repository, { probe: readyProbe, executor: { async run(input) {
      for (const event of [{ type: 'thread.started', thread_id: 'completion-fixture' }, { type: 'turn.started' }, { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }]) await input.onRawEvent(event);
      return { exitCode: 0, exitSignal: null, stderrTail: '', stderrTruncated: false, aborted: false, spawned: false };
    } } }), { async finalizer(claim, _outcome, context, signal) {
      const report = await verifyEngineeringAttempt(f.repository, claim, context, signal); assert.equal(report.status, 'passed');
      if (mode === 'cancel') f.repository.queue.controlTask('task', 'cancel', f.repository.getTask('task').revision, actor, 'Injected owner cancellation before final commit');
      else { const evidence = await f.repository.verifyStoredArtifact(report.steps[0].stdoutArtifactId); await writeFile(join(f.repository.dataDirectory, evidence.location), 'corrupted after verification'); }
      await f.repository.queue.finalizeVerification(claim, report.id, context);
    } });
    try {
      const status = await scheduler.runUntilIdle({ timeoutMs: 30000 }); assert.equal(status.completed, 0);
      assert.equal(f.repository.getTask('task').state, mode === 'cancel' ? 'cancelled' : 'failed');
    } finally { await scheduler.shutdown(); await f.cleanup(); }
  }
});
