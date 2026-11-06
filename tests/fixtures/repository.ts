import type { TaskSpec, CommandActor } from '../../packages/shared/src/domain.js';
import type { TaskSubmission } from '../../packages/shared/src/repository.js';
import { taskFixture } from './domain.js';
export const repositoryActor: CommandActor = { actorId: 'owner', source: 'cli', requestId: 'fixture-request' };
export const repositoryTaskId = (index: number): string => `CTX-${String(index).padStart(3, '0')}`;
export function submissionFixture(id: string, dependencies: string[] = []): TaskSubmission & { spec: TaskSpec } {
  return { spec: { ...structuredClone(taskFixture), id, title: `Implement ${id}`, dependsOn: dependencies }, deduplicationKey: `event-${id}`, destination: { kind: 'local', address: 'owner' } };
}
