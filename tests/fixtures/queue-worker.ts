import { TaskRepository } from '../../packages/persistence/src/task-repository.js';
import { DurableScheduler } from '../../packages/core/src/durable-scheduler.js';
import { FixtureWorker, fixtureReceiptPath } from '../../packages/core/src/fixture-worker.js';
import { queueActor, queueSubmission } from './queue.js';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import type { LeaseClaim } from '../../packages/shared/src/scheduling.js';
const [filename, mode, workerId = 'worker'] = process.argv.slice(2);
const repository = await TaskRepository.open(filename);
if (mode === 'stress') {
  process.send?.({ ready: true }); await once(process, 'message'); const claims = [];
  for (let i = 0; i < 4; i++) {
    repository.submitTask(queueSubmission(`${workerId}-${i}`), queueActor); repository.queue.refresh(queueActor);
    const claim = repository.queue.claim({ ownerId: workerId, workerKind: 'fixture', leaseMs: 500 }, queueActor); if (claim) claims.push(claim);
  }
  setInterval(() => {}, 1000); process.send?.({ claims });
} else {
  const hold = async (claim: LeaseClaim) => {
    setInterval(() => {}, 1000);
    process.send?.({ claim, ...(mode === 'after-receipt' ? { receipt: JSON.parse(await readFile(fixtureReceiptPath(repository.dataDirectory, claim), 'utf8')) } : {}) });
    await new Promise(() => {});
  };
  const scheduler = new DurableScheduler(repository, new FixtureWorker(repository.dataDirectory, {}, mode === 'after-receipt' ? { wrote: hold } : { started: hold }), { leaseMs: 300 });
  scheduler.tick();
}
