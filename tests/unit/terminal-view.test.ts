import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeText, reportView, securityView, taskProgress } from '../../apps/cli/src/terminal-view.js';
import type { Report } from '../../packages/shared/src/contracts.js';
import type { TaskRecord } from '../../packages/core/src/types.js';
test('terminal output neutralizes escape sequences and backend errors stay in technical details', () => {
  assert.equal(safeText('hello\x1b[2J\x1b]0;spoofed\x07world'), 'helloworld');
  const report = { outcome: 'blocked', verification: [], environment: { diagnostic: { kind: 'stale-session-groups' } }, implemented: { summary: 'Codex SDK internal failure', diff: '/task/changes.diff' }, workspacePath: '/work' } as unknown as Report;
  const text = reportView(report); assert.match(text, /Docker is unavailable/); assert.doesNotMatch(text, /SDK/); assert.match(text, /Security\s+not run/);
});
test('unavailable security never appears as a clean scan', () => {
  const text = securityView({ status: 'unavailable', findings: [], coverage: [], limitations: ['@openai/codex-security authentication required'] });
  assert.match(text, /no security conclusion/); assert.doesNotMatch(text, /No findings|codex-security/); assert.match(text, /Coverage: unverified/);
});
test('progress uses product stages and check outcomes', () => {
  const text = taskProgress({ status: 'verifying', plan: { steps: [] }, verification: [{ name: 'build', status: 'passed' }] } as unknown as TaskRecord);
  assert.equal(text, 'Running checks · build: passed');
});
