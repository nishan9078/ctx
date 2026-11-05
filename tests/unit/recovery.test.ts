import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recoveryProblem } from '../../packages/core/src/recovery.js';
import type { TaskRecord } from '../../packages/core/src/types.js';
const task = (overrides: Partial<TaskRecord> = {}): TaskRecord => ({
  id: 'task', request: 'feature', repositoryPath: '/repo', directory: '/output/task', workspacePath: '/workspace',
  status: 'executing', createdAt: '', updatedAt: '', plan: { version: 1, steps: [{ id: 'a', title: 'a', instructions: 'a', dependencies: [], acceptanceCriteria: ['works'], status: 'running' }] },
  commands: {}, prepared: true, maxRepairAttempts: 0, remainingRepairAttempts: 0, attempts: [{ id: 'attempt', stepId: 'a', idempotencyKey: 'key', status: 'running', startedAt: '', sessionId: 'known-session' }],
  verification: [], timeoutMs: 1000, elapsedMs: 0, ...overrides,
});
test('interrupted turns retain session context and require reconciliation', () => {
  assert.match(recoveryProblem(task())!, /known-session/);
  const confirmed = task(); confirmed.attempts[0].result = { outcome: 'completed', summary: 'Done' };
  assert.equal(recoveryProblem(confirmed), undefined);
});
test('does not infer workspace preparation or check success from partial output', () => {
  assert.match(recoveryProblem(task({ status: 'preparing', prepared: false }))!, /preparation was interrupted/);
  assert.match(recoveryProblem(task({ activeCheck: 'test' }))!, /unknown outcome/);
});
