import type { TaskStatus, StepStatus } from './types.js';
const transitions: Record<TaskStatus, TaskStatus[]> = {
  queued: ['planning', 'cancelled', 'failed'], planning: ['preparing', 'awaiting_approval', 'failed', 'blocked', 'cancelled'],
  preparing: ['executing', 'awaiting_approval', 'blocked', 'failed', 'cancelled'],
  executing: ['verifying', 'awaiting_approval', 'blocked', 'failed', 'cancelled'],
  verifying: ['completed', 'repairing', 'blocked', 'failed', 'cancelled'], repairing: ['executing', 'failed', 'blocked', 'cancelled'],
  awaiting_approval: ['preparing', 'blocked', 'cancelled'], blocked: [], completed: [], failed: [], cancelled: [],
};
const stepTransitions: Record<StepStatus, StepStatus[]> = {
  pending: ['running', 'blocked'], running: ['passed', 'failed', 'blocked'], passed: ['pending'], failed: ['pending'], blocked: [],
};
export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (from !== to && !transitions[from].includes(to)) throw new Error(`Invalid task transition: ${from} -> ${to}`);
}
export function assertStepTransition(from: StepStatus, to: StepStatus): void {
  if (from !== to && !stepTransitions[from].includes(to)) throw new Error(`Invalid step transition: ${from} -> ${to}`);
}
export const terminal = (status: TaskStatus): boolean => ['completed', 'failed', 'blocked', 'cancelled'].includes(status);
