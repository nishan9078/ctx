// Legacy schema-v2 storage record; V1 domain contracts live in shared/domain.ts.
import type { EnvironmentState } from '../../environment/src/types.js';
import type { AgentResult } from '../../agents/src/agent-adapter.js';
import type { Report, CheckResult } from '../../shared/src/contracts.js';
import type { TaskStatus, StepStatus } from '../../shared/src/legacy-transitions.js';
export type { TaskStatus, StepStatus } from '../../shared/src/legacy-transitions.js';
export interface PlanStep {
  id: string; title: string; instructions: string; dependencies: string[];
  acceptanceCriteria: string[]; status: StepStatus;
}
export interface Plan { version: number; steps: PlanStep[] }
export interface Attempt {
  id: string; stepId: string; idempotencyKey: string; status: 'running' | 'completed' | 'failed' | 'interrupted';
  sessionId?: string; summary?: string; usage?: Record<string, number>; result?: AgentResult; startedAt: string; finishedAt?: string;
}
export interface TaskRecord {
  id: string; request: string; repositoryPath: string; directory: string; workspacePath: string;
  status: TaskStatus; createdAt: string; updatedAt: string;
  verificationPlan?: import('../../verification/src/planner.js').VerificationPlan;
  applyManifest?: string;
  verificationPolicy?: import('../../verification/src/policy.js').VerificationPolicy;
  plan: Plan; commands: { build?: string; test?: string; typecheck?: string; security?: string; browser?: string }; prepared: boolean;
  maxRepairAttempts: number; remainingRepairAttempts: number;
  attempts: Attempt[]; verification: CheckResult[]; activeCheck?: string;
  environment?: EnvironmentState;
  timeoutMs: number; elapsedMs: number; model?: string; error?: string; report?: Report;
}
