import { TaskRepository } from '../../packages/persistence/src/task-repository.js';
import { ArtifactStore } from '../../packages/persistence/src/artifact-store.js';
import { repositoryActor, submissionFixture } from './repository.js';
import { join } from 'node:path';
const [root] = process.argv.slice(2);
const repository = await TaskRepository.open(join(root, 'state.sqlite'));
await repository.registerProject({ id: 'fixture', repositoryPath: root, policyId: 'safe', verificationProfile: 'node-api' }, repositoryActor, 'Fixture registration');
repository.submitTask(submissionFixture('artifact-task'), repositoryActor);
const store = await ArtifactStore.open(root);
await store.writeText({ taskId: 'artifact-task', kind: 'log', retention: 'log' }, 'Staged evidence', repository, repositoryActor, { async beforePublish(directory) {
  setInterval(() => {}, 1000); process.send?.({ directory }); await new Promise(() => {});
} });
