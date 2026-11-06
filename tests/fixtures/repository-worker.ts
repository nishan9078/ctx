import { TaskRepository } from '../../packages/persistence/src/task-repository.js';
import { repositoryActor, repositoryTaskId, submissionFixture } from './repository.js';
const [filename, directory, mode] = process.argv.slice(2);
if (!filename || !directory || !['batch', 'single'].includes(mode)) throw new Error('Expected repository fixture arguments');
const repository = await TaskRepository.open(filename);
await repository.registerProject({ id: 'fixture', repositoryPath: directory, policyId: 'safe', verificationProfile: 'node-api' }, repositoryActor, 'Owner registered fixture');
if (mode === 'single') {
  const result = repository.submitTask(submissionFixture('single'), repositoryActor);
  repository.close();
  process.send?.(result, () => process.disconnect?.());
} else {
  const tasks = [];
  for (let i = 0; i < 15; i++) {
    const id = repositoryTaskId(i);
    let task = repository.submitTask(submissionFixture(id, i ? [repositoryTaskId(i - 1)] : []), repositoryActor).task;
    if (i % 3 === 1) task = repository.transitionTask(id, 'paused', task.revision, repositoryActor, 'Owner paused fixture');
    if (i % 3 === 2) task = repository.transitionTask(id, 'waiting_dependency', task.revision, repositoryActor, 'Prerequisite is unfinished');
    tasks.push(task);
  }
  // Deliberately keep the database open until the parent kills this acknowledged process.
  setInterval(() => {}, 1000);
  process.send?.({ tasks, notifications: repository.pendingNotifications(), events: repository.events() });
}
