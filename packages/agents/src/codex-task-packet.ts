import type { TaskSpec } from '../../shared/src/domain.js';

/**
 * Canonical task packet handed to Codex (P04-05).
 * Carries objective, included/excluded scope, acceptance criteria,
 * verification profile and expected result format, plus the fixed
 * execution restrictions enforced by the SDK thread options.
 */
export const codexRestrictions = Object.freeze([
  'Sandbox mode: workspace-write (writes stay inside the task workspace)',
  'Approval policy: never (no permission escalation or interactive prompts)',
  'Network access: disabled; web search: disabled',
  'Modify only files inside the isolated task workspace; the source checkout is never modified',
]);
export interface CodexTaskPacket {
  taskId: string;
  objective: string;
  include: string[]; exclude: string[];
  acceptance: string[];
  verificationProfile: string;
  expectedResultFormat: string;
  restrictions: readonly string[];
}
export function buildCodexTaskPacket(spec: TaskSpec): CodexTaskPacket {
  return {
    taskId: spec.id,
    objective: spec.objective,
    include: [...spec.scope.include],
    exclude: [...spec.scope.exclude],
    acceptance: [...spec.acceptance],
    verificationProfile: spec.verificationProfile,
    expectedResultFormat: 'A short, reviewable summary of what changed and how, followed by the list of changed files.',
    restrictions: codexRestrictions,
  };
}
export function formatCodexPrompt(packet: CodexTaskPacket): string {
  const lines = [
    'You are executing a queued CTX engineering task inside an isolated workspace.',
    '',
    `Task ID: ${packet.taskId}`,
    `Objective: ${packet.objective}`,
    '',
    `In scope: ${packet.include.length ? packet.include.join(', ') : '(whole workspace)'}`,
    `Out of scope: ${packet.exclude.length ? packet.exclude.join(', ') : '(none declared)'}`,
    '',
    'Acceptance criteria:',
    ...packet.acceptance.map(item => `- ${item}`),
    '',
    `Verification profile (independent verification runs after you finish): ${packet.verificationProfile}`,
    `Expected result format: ${packet.expectedResultFormat}`,
    '',
    'Execution restrictions:',
    ...packet.restrictions.map(item => `- ${item}`),
    '',
    'Make the smallest reviewable change that satisfies the acceptance criteria.',
  ];
  return lines.join('\n');
}
