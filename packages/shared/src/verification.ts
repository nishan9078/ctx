/** Neutral verification contracts: no implementation imports. */
export type ProjectKind = 'static-html' | 'javascript' | 'typescript' | 'backend' | 'documentation' | 'filesystem' | 'mixed' | 'unknown';
export type Requirement = 'mandatory' | 'optional' | 'not-applicable';
export interface PlannedCheck {
  id: string;
  kind: 'command' | 'acceptance' | 'artifacts' | 'syntax' | 'documentation' | 'browser';
  requirement: Requirement;
  reason: string;
  command?: string;
  paths: string[];
  absentPaths?: string[];
}
export interface VerificationPlan {
  version: 1;
  phase: 'initial' | 'resolved';
  projects: ProjectKind[];
  checks: PlannedCheck[];
  changedFiles: string[];
  limitations: string[];
}
