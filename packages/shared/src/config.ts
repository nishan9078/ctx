import type { ApprovalAction, Notification } from './domain.js';
export type ProjectCommands = Partial<Record<'build' | 'test' | 'typecheck' | 'security' | 'browser', string>>;
export interface ProjectConfig {
  id: string; repositoryPath: string; verificationProfile: string; commands: ProjectCommands;
}
export interface CtxConfig {
  schemaVersion: 1;
  runtime: { mode: 'local'; maxWorkers: number; maxWorkersPerProject: number; idleWorkerShutdownSeconds: number; diskFreeMinGb: number; maxAttemptWallMinutes: number; shutdownGraceSeconds: number };
  capacity: { probePaidEndpoints: boolean; unknownLimitBackoffSeconds: number[] };
  notifications: { discord: boolean; eventTypes: Notification['kind'][] };
  security: { defaultNetwork: 'restricted'; requireApproval: ApprovalAction[]; allowRepositories: string[] };
  projects: ProjectConfig[];
}
export interface ResolvedProjectConfig { config: CtxConfig; project: ProjectConfig }
