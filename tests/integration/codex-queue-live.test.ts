import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { TaskRepository } from '../../packages/persistence/src/task-repository.js';
import { createCodexQueueScheduler } from '../../packages/core/src/codex-queue-worker.js';
import { liveProcessGroup } from '../../packages/core/src/supervised-codex-executor.js';
import { probeCodex } from '../../packages/agents/src/codex-probe.js';
import { repositoryActor as actor, submissionFixture } from '../fixtures/repository.js';

test('LIVE queue: Codex edits an isolated approved fixture and preserves evidence without bypassing verification', { skip: process.env.HARNESS_CODEX_QUEUE_LIVE !== '1', timeout: 180000 }, async () => {
  const root = resolve('.harness/phase04-live', randomUUID()); const source = join(root, 'source');
  await mkdir(source, { recursive: true, mode: 0o700 }); await writeFile(join(source, 'README.md'), 'Disposable CTX Phase 04 fixture.\n');
  const repository = await TaskRepository.open(join(root, 'data', 'state.sqlite'));
  await repository.registerProject({ id: 'fixture', repositoryPath: source, policyId: 'safe', verificationProfile: 'node-api' }, actor, 'Owner-approved disposable live fixture');
  const submission = submissionFixture('phase04-live');
  submission.spec.objective = 'Create result.txt containing exactly phase04-live followed by one newline. Make no other changes. Do not install packages or use network access. Return a short summary.';
  submission.spec.scope = { include: ['result.txt'], exclude: [] }; submission.spec.acceptance = ['result.txt contains exactly phase04-live followed by one newline']; submission.spec.maxAttempts = 1; submission.spec.maxWallMinutes = 2;
  repository.submitTask(submission, actor);
  const scheduler = createCodexQueueScheduler(repository);
  console.log(`Live Phase 04 evidence: ${root}`);
  try {
    const status = await scheduler.runUntilIdle({ timeoutMs: 60000 });
    const attempt = repository.queue.attempts('phase04-live')[0];
    const artifacts = repository.artifacts('phase04-live');
    const artifactText = async (kind: string) => {
      const descriptor = artifacts.find(a => a.kind === kind); assert.ok(descriptor, `Missing ${kind}; task=${JSON.stringify(repository.getTask('phase04-live'))}`);
      await repository.verifyStoredArtifact(descriptor.id); return readFile(join(repository.dataDirectory, descriptor.location), 'utf8');
    };
    const result = JSON.parse(await artifactText('codex-result')); const patch = await artifactText('codex-diff');
    const evidence = { root, readiness: await probeCodex(), taskState: repository.getTask('phase04-live').state, attemptState: attempt.state, sessionId: repository.queue.session(attempt.id)?.externalSessionId, usage: result.usage, model: result.model, provider: result.provider, artifactCount: artifacts.length, eventCount: repository.queue.workerEvents(attempt.id).length, worker: repository.queue.workerProcess(attempt.id) };
    await writeFile(join(root, 'summary.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
    assert.equal(result.terminal, 'completed', JSON.stringify(evidence));
    assert.equal(status.blocked, 1); assert.equal(status.completed, 0); assert.equal(status.running, 0); assert.equal(scheduler.lastError, undefined);
    assert.equal(await readFile(join(result.workspace, 'result.txt'), 'utf8'), 'phase04-live\n'); assert.match(patch, /\+phase04-live/);
    await assert.rejects(readFile(join(source, 'result.txt')), { code: 'ENOENT' });
    assert.ok(evidence.sessionId); assert.ok(repository.queue.workerEvents(attempt.id).some(e => e.type === 'completed'));
    assert.deepEqual(liveProcessGroup(evidence.worker!.pgid), []);
  } finally { await scheduler.shutdown(); repository.close(); }
});
