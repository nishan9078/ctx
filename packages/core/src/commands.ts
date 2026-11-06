import type { ApprovalRequest, Notification, TaskSpec, TaskState } from '../../shared/src/domain.js';
import type { CtxError } from '../../shared/src/errors.js';

/** Trusted ingress establishes identity; task descriptions and MCP content cannot grant it. */
export interface CommandContext { actorId: string; source: 'cli' | 'discord' | 'local'; requestId: string }
export interface TaskSnapshot { spec: TaskSpec; state: TaskState; revision: number; reason?: string; nextRunAt?: string }
interface RevisionCommand { taskId: string; expectedRevision: number }
export interface CommandInputs {
  submit: { spec: TaskSpec; deduplicationKey: string };
  cancel: RevisionCommand & { reason: string };
  pause: RevisionCommand & { reason: string };
  resume: RevisionCommand;
  approve: RevisionCommand & { approvalId: string; actionHash: string; decision: 'approved' | 'rejected' };
  retry: RevisionCommand & { reason: string };
  query: { taskId?: string; states?: TaskState[]; limit: number; cursor?: string };
}
export interface CommandOutputs {
  submit: { task: TaskSnapshot; duplicate: boolean; acknowledgement: Notification };
  cancel: TaskSnapshot;
  pause: TaskSnapshot;
  resume: TaskSnapshot;
  approve: { task: TaskSnapshot; approval: ApprovalRequest };
  retry: TaskSnapshot;
  query: { tasks: TaskSnapshot[]; nextCursor?: string };
}
export type CommandName = keyof CommandInputs;
export type CommandResult<T> = { ok: true; value: T } | { ok: false; error: ReturnType<CtxError['toJSON']> };
/** Contract only: persistence-backed handlers arrive in P02/P03; IPC in P08. */
export interface CommandBus {
  execute<K extends CommandName>(name: K, input: CommandInputs[K], context: CommandContext): Promise<CommandResult<CommandOutputs[K]>>;
}
