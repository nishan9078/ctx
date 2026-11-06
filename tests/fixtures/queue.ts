import { fixtureAcceptance } from '../../packages/shared/src/scheduling.js';
import { submissionFixture, repositoryActor } from './repository.js';
export const queueActor = repositoryActor;
export function queueSubmission(id: string, dependencies: string[] = [], projectId = 'fixture') {
  const input = submissionFixture(id, dependencies); input.spec.projectId = projectId;
  input.spec.verificationProfile = 'fixture-v1'; input.spec.acceptance = [fixtureAcceptance]; return input;
}
