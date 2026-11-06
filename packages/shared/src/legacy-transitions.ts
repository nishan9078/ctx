import { InvalidTransitionError } from './errors.js';
/** Persisted v0 runner vocabulary. Do not replace with V1 TaskState without a migration. */
export type TaskStatus = 'queued' | 'planning' | 'preparing' | 'executing' | 'verifying' | 'repairing' | 'awaiting_approval' | 'blocked' | 'completed' | 'failed' | 'cancelled';
export type StepStatus = 'pending' | 'running' | 'passed' | 'failed' | 'blocked';
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
  if (!Object.hasOwn(transitions, from) || !Object.hasOwn(transitions, to) || from !== to && !transitions[from].includes(to)) throw new InvalidTransitionError();
}
export function assertStepTransition(from: StepStatus, to: StepStatus): void {
  if (!Object.hasOwn(stepTransitions, from) || !Object.hasOwn(stepTransitions, to) || from !== to && !stepTransitions[from].includes(to)) throw new InvalidTransitionError();
}
export const terminal = (status: TaskStatus): boolean => ['completed', 'failed', 'blocked', 'cancelled'].includes(status);
