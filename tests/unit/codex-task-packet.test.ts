import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCodexTaskPacket, formatCodexPrompt } from '../../packages/agents/src/codex-task-packet.js';
import type { TaskSpec } from '../../packages/shared/src/domain.js';

const spec = {
  schemaVersion: 1, id: 'T-1', projectId: 'p', title: 't', objective: 'Add the feature',
  scope: { include: ['src/**'], exclude: ['infra/**'] }, acceptance: ['Works', 'Tested'],
  dependsOn: [], priority: 'normal', risk: 'medium', mode: 'delegated', preferredHarness: 'auto',
  verificationProfile: 'node-api', requiresApprovalFor: [], maxAttempts: 3, maxWallMinutes: 5, metadata: { source: 'cli' },
} as TaskSpec;

test('task packet carries objective, scope, acceptance and verification profile', () => {
  const packet = buildCodexTaskPacket(spec);
  assert.equal(packet.objective, 'Add the feature');
  assert.deepEqual(packet.include, ['src/**']);
  assert.deepEqual(packet.exclude, ['infra/**']);
  assert.deepEqual(packet.acceptance, ['Works', 'Tested']);
  assert.equal(packet.verificationProfile, 'node-api');
  const prompt = formatCodexPrompt(packet);
  assert.match(prompt, /workspace-write/);
  assert.match(prompt, /Approval policy: never/);
  assert.match(prompt, /Network access: disabled/);
  assert.match(prompt, /source checkout is never modified/);
  assert.match(prompt, /smallest reviewable change/);
});
