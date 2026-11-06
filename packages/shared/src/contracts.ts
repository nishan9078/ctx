export interface CheckResult {
  name: string;
  requirement?: import('../../verification/src/planner.js').Requirement;
  reason?: string; limitations?: string[];
  command: string;
  status: 'passed' | 'failed' | 'unavailable' | 'cancelled' | 'not-applicable';
  exitCode: number | null;
  durationMs: number;
  artifact: string;
}
export interface Report {
  id: string;
  request: string;
  repositoryPath: string;
  workspacePath?: string;
  outcome: 'completed' | 'blocked' | 'failed' | 'cancelled';
  implemented: { summary: string; diff: string; hasChanges: boolean };
  verificationPlan?: import('../../verification/src/planner.js').VerificationPlan;
  verification: CheckResult[];
  security: { status: 'unavailable'; coverage: string[] };
  environment: { dependencies: string; resources: string[]; execution?: 'docker' | 'host' | 'filesystem'; recoveries?: { kind: string; status: string; artifact: string }[]; cleanupErrors?: string[]; diagnostic?: { kind: string; recommendation: string; artifact?: string } };
  limitations: string[];
  usage: { elapsedMs: number; agentTurns: number; retries: number; tokens?: Record<string, number> };
  execution?: { phase: 'cancelled' | 'environment-failed' | 'codex-not-started' | 'codex-failed' | 'verification-failed' | 'completed'; codexStarted: boolean; turns: number };
  acceptance?: { criteria: unknown[]; manifest: string };
  sessionId?: string;
  nextActions: string[];
}
