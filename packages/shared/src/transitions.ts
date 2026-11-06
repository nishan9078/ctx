import type { TaskState } from './domain.js';
import { InvalidTransitionError } from './errors.js';

/** Structural transitions only. Transactions enforce leases, evidence and approval guards. */
export const taskTransitions: Readonly<Record<TaskState, readonly TaskState[]>> = Object.freeze({
  draft: Object.freeze(['queued', 'blocked', 'cancelled'] as const),
  queued: Object.freeze(['waiting_dependency', 'ready', 'paused', 'cancelled'] as const),
  waiting_dependency: Object.freeze(['ready', 'blocked', 'paused', 'cancelled'] as const),
  ready: Object.freeze(['leased', 'waiting_capacity', 'waiting_approval', 'waiting_dependency', 'paused', 'cancelled'] as const),
  leased: Object.freeze(['running', 'recovering', 'blocked', 'cancelled'] as const),
  running: Object.freeze(['verifying', 'waiting_capacity', 'waiting_approval', 'recovering', 'failed', 'cancelled'] as const),
  verifying: Object.freeze(['completed', 'recovering', 'blocked', 'failed', 'cancelled'] as const),
  recovering: Object.freeze(['running', 'waiting_capacity', 'waiting_approval', 'blocked', 'failed', 'cancelled'] as const),
  waiting_capacity: Object.freeze(['ready', 'blocked', 'paused', 'cancelled'] as const),
  waiting_approval: Object.freeze(['ready', 'blocked', 'paused', 'cancelled'] as const),
  paused: Object.freeze(['queued', 'cancelled'] as const),
  blocked: Object.freeze(['queued', 'cancelled'] as const),
  completed: Object.freeze([]), failed: Object.freeze([]), cancelled: Object.freeze([]),
});
export function assertTaskTransition(from: TaskState, to: TaskState): void {
  if (!Object.hasOwn(taskTransitions, from) || !taskTransitions[from].includes(to)) throw new InvalidTransitionError();
}
export function isTerminalState(state: TaskState): boolean { return ['completed', 'failed', 'cancelled'].includes(state); }
