import type { CommandActor, Notification, TaskSnapshot } from './domain.js';
export interface ProjectRegistration { id: string; repositoryPath: string; policyId: string; verificationProfile: string }
export interface RegisteredProject extends ProjectRegistration { createdAt: string }
export interface TaskSubmission {
  spec: unknown; deduplicationKey: string;
  /** Delivery routing is supplied by trusted ingress, never inferred from task content. */
  destination: Notification['destination'];
}
export interface SubmissionResult { task: TaskSnapshot; duplicate: boolean; acknowledgement: Notification }
export interface AuditEvent {
  sequence: number; entity: string; entityId: string; taskId?: string;
  type: string; actor: string; reason: string; payload: unknown; createdAt: string;
}
export type RepositoryActor = CommandActor;
