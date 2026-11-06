import type { TaskSpec, PortableCheckpoint } from '../../packages/shared/src/domain.js';
export const taskFixture: TaskSpec = {
  schemaVersion: 1, id: 'CTX-104', projectId: 'fixture', title: 'Implement endpoint', objective: 'Add and independently test the endpoint',
  scope: { include: ['src/**', 'tests/**'], exclude: ['infra/production/**'] }, acceptance: ['Valid input succeeds', 'Invalid input returns 4xx'], dependsOn: ['CTX-101'],
  priority: 'normal', risk: 'medium', mode: 'delegated', preferredHarness: 'auto', verificationProfile: 'node-api', requiresApprovalFor: ['deployment', 'destructive_db', 'external_write'], maxAttempts: 3, maxWallMinutes: 60, metadata: { source: 'cli' },
};
export const checkpointFixture: PortableCheckpoint = {
  schemaVersion: 1, taskId: 'CTX-104', attemptId: 'attempt-1', projectId: 'fixture', baseCommit: 'a'.repeat(40), branch: 'ctx/CTX-104', worktree: '/tmp/ctx-fixture/workspace', objective: taskFixture.objective,
  completedSteps: ['Added validation'], pendingSteps: ['Run verifier'], decisions: ['Use existing middleware'], changedFiles: ['src/endpoint.ts'], knownBlockers: [], lastVerification: { status: 'failed', reason: 'Test missing' }, sessionRefs: { codex: 'thread-1' }, artifactHashes: { patch: 'b'.repeat(64) },
};
