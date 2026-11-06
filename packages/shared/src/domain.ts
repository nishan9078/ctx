import type { ErrorCode } from './errors.js';

export const taskStates = ['draft', 'queued', 'ready', 'leased', 'running', 'verifying', 'recovering', 'waiting_capacity', 'waiting_dependency', 'waiting_approval', 'paused', 'blocked', 'completed', 'failed', 'cancelled'] as const;
export type TaskState = typeof taskStates[number];
export type HarnessId = 'codex' | 'opencode';
export type ApprovalAction = 'deployment' | 'destructive_db' | 'external_write' | 'payment' | 'secret_write';
export interface TaskSpec {
  schemaVersion: 1;
  id: string;
  projectId: string;
  title: string;
  objective: string;
  scope: { include: string[]; exclude: string[] };
  acceptance: string[];
  dependsOn: string[];
  priority: 'low' | 'normal' | 'high' | 'urgent';
  risk: 'low' | 'medium' | 'high';
  mode: 'delegated' | 'interactive';
  preferredHarness: HarnessId | 'auto';
  verificationProfile: string;
  requiresApprovalFor: ApprovalAction[];
  maxAttempts: number;
  maxWallMinutes: number;
  metadata: { source: 'cli' | 'discord' | 'local'; externalId?: string };
}
export interface Attempt {
  id: string; taskId: string; sequence: number; taskRevision: number;
  state: 'leased' | 'running' | 'verifying' | 'completed' | 'failed' | 'interrupted' | 'cancelled';
  harnessId: HarnessId; providerKey: string; modelId: string;
  fencingToken: number; startedAt: string; endedAt?: string; sessionId?: string;
}
export interface VerificationResult {
  id: string; attemptId: string; profile: string;
  status: 'passed' | 'failed' | 'unavailable' | 'cancelled' | 'not_run';
  checks: { name: string; required: boolean; status: 'passed' | 'failed' | 'unavailable' | 'cancelled' | 'not-applicable'; command?: string; exitCode: number | null; artifactId?: string }[];
  artifactIds: string[]; limitations: string[];
}
export interface CapacityState {
  /** Provider/account/model pool identity; harness identity alone is insufficient. */
  providerKey: string; status: 'available' | 'cooldown' | 'unknown' | 'disabled';
  retryAt?: string; observedAt: string; source: 'provider' | 'probe' | 'operator';
  confidence: 'authoritative' | 'observed' | 'estimated';
}
export interface ApprovalRequest {
  id: string; taskId: string; taskRevision: number; attemptId?: string;
  action: ApprovalAction; actionHash: string; requestedBy: string; expiresAt: string;
  decision: 'pending' | 'approved' | 'rejected' | 'expired'; decidedBy?: string; decidedAt?: string;
}
export interface Notification {
  id: string; taskId: string; destination: { kind: 'local' | 'discord'; address: string };
  kind: 'accepted' | 'progress' | 'completed' | 'blocked' | 'approval_requested' | 'capacity_wait';
  deduplicationKey: string; message: string; createdAt: string; nextAttemptAt: string;
  retryCount: number; remoteMessageId?: string; deliveredAt?: string;
}
interface EventContext { taskId: string; attemptId: string; sequence: number; timestamp: string }
export type WorkerEvent = EventContext & (
  | { type: 'started'; harnessId: HarnessId; sessionId?: string }
  | { type: 'message_delta'; text: string }
  | { type: 'tool_started'; toolId: string; name: string }
  | { type: 'tool_completed'; toolId: string; success: boolean }
  | { type: 'command_executed'; command: string; exitCode: number | null; artifactId: string }
  | { type: 'files_changed'; paths: string[] }
  | { type: 'permission_requested'; approval: ApprovalRequest }
  | { type: 'usage_reported'; inputTokens: number; outputTokens: number; costUsd?: number }
  | { type: 'rate_limited'; capacity: CapacityState }
  | { type: 'failed'; code: ErrorCode; message: string; retryable: boolean }
  | { type: 'completed'; summary: string; artifactIds: string[] }
  | { type: 'interrupted'; reason: string }
);
export interface PortableCheckpoint {
  schemaVersion: 1; taskId: string; attemptId: string; projectId: string;
  baseCommit: string; branch: string; worktree: string; objective: string;
  completedSteps: string[]; pendingSteps: string[]; decisions: string[];
  changedFiles: string[]; knownBlockers: string[];
  lastVerification: { status: VerificationResult['status']; reason: string };
  sessionRefs: Partial<Record<HarnessId, string>>;
  artifactHashes: Record<string, string>;
}
