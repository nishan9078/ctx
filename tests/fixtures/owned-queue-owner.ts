import { TaskRepository } from '../../packages/persistence/src/task-repository.js';
import { createCodexQueueScheduler } from '../../packages/core/src/codex-queue-worker.js';
import { SupervisedCodexExecutor } from '../../packages/core/src/supervised-codex-executor.js';
const repository = await TaskRepository.open(process.argv[2]);
const executor = new SupervisedCodexExecutor({ codexPathOverride: process.argv[3], graceMs: 50, env: { ...process.env, CTX_SDK_FIXTURE: 'hang' } });
const scheduler = createCodexQueueScheduler(repository, { leaseMs: 1000,
  probe: async () => ({ sdkVersion: '0.166.0', cliVersion: 'fixture', cliAvailable: true, auth: 'auth-file', model: 'unknown', provider: 'unknown', probeErrors: [] }),
  executor: { run: input => executor.run({ ...input, async onRawEvent(raw) {
    await input.onRawEvent(raw);
    if ((raw as { type?: string }).type === 'item.completed') {
      const attempt = repository.queue.attempts('task')[0];
      process.send?.({ type: 'running', workspaceId: attempt.id, pgid: repository.queue.workerProcess(attempt.id)!.pgid });
    }
  } }) },
});
await scheduler.runUntilIdle({ timeoutMs: 60000 });
process.send?.({ type: 'stopped', reason: scheduler.lastError });
await scheduler.shutdown(); repository.close(); if (process.connected) process.disconnect();
