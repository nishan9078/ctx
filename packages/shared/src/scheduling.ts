import type { Attempt, CommandActor, TaskSnapshot, WorkerKind } from './domain.js';
export const fixtureAcceptance = 'Fixture output matches task ID and objective';
export interface QueueConfiguration { maxWorkers: number; maxWorkersPerProject: number; paused: boolean }
export interface LeaseClaim { task: TaskSnapshot; attempt: Attempt; ownerId: string; fencingToken: number; expiresAt: string }
export interface QueueStatus {
  configuration: QueueConfiguration; total: number; running: number; ready: number; waiting: number;
  blocked: number; completed: number; failed: number; cancelled: number; paused: number; nextRunAt?: string;
}
export interface ClaimInput { ownerId: string; workerKind: WorkerKind; leaseMs: number }
export type WorkerOutcome = { kind: 'success' } | { kind: 'failed'; reason: string; retryable: boolean; delayMs?: number }
  | { kind: 'capacity'; reason: string; delayMs: number } | { kind: 'approval'; reason: string };
export interface QueueWorker {
  readonly kind: WorkerKind;
  execute(input: { claim: LeaseClaim; signal: AbortSignal }): Promise<WorkerOutcome>;
}
export interface FixtureVerification { resultArtifactId: string; reportArtifactId: string }
export type QueueActor = CommandActor;
