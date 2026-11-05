import type { TaskRecord } from './types.js';
export function recoveryProblem(task: TaskRecord): string | undefined {
  if (task.status === 'preparing' && !task.prepared) return 'Workspace preparation was interrupted. Inspect the retained workspace; automatic recopy is disabled.';
  if (task.environment?.activeRecovery !== undefined) return 'Environment recovery has an unknown interrupted outcome. Inspect managed resources and recovery logs; it will not be replayed automatically.';
  if (task.activeCheck) return `Verification command ${task.activeCheck} was interrupted with an unknown outcome. Inspect its processes and side effects; it will not be replayed automatically.`;
  const running = task.plan.steps.find(step => step.status === 'running');
  if (running) {
    const attempt = task.attempts.findLast(item => item.stepId === running.id);
    if (!attempt?.result) return `Agent attempt ${attempt?.id ?? running.id} has an unknown outcome. Session: ${attempt?.sessionId ?? 'not captured'}. Inspect the session, processes and workspace; no agent turn will be replayed automatically.`;
  }
  return undefined;
}
