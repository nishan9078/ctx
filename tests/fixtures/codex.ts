import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskRepository } from '../../packages/persistence/src/task-repository.js';
import { repositoryActor as actor, submissionFixture } from './repository.js';
export async function codexFixture() {
  const root = await mkdtemp(join(tmpdir(), 'ctx-codex-')); const project = join(root, 'project'); await mkdir(project);
  const filename = join(root, 'data', 'state.sqlite'); const repository = await TaskRepository.open(filename);
  await repository.registerProject({ id: 'fixture', repositoryPath: project, policyId: 'safe', verificationProfile: 'node-api' }, actor, 'Approved local fixture');
  repository.submitTask(submissionFixture('task'), actor); repository.queue.refresh(actor);
  return { root, filename, project, repository, async cleanup() { repository.close(); await rm(root, { recursive: true, force: true }); } };
}
