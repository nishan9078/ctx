export interface CheckResult {
  name: 'build' | 'test';
  command: string;
  status: 'passed' | 'failed' | 'unavailable' | 'cancelled';
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
  verification: CheckResult[];
  security: { status: 'unavailable'; coverage: string[] };
  environment: { dependencies: string; resources: string[]; execution?: 'docker' | 'host'; recoveries?: { kind: string; status: string; artifact: string }[]; cleanupErrors?: string[]; diagnostic?: { kind: string; recommendation: string; artifact?: string } };
  limitations: string[];
  usage: { elapsedMs: number; agentTurns: number; retries: number; tokens?: Record<string, number> };
  sessionId?: string;
  nextActions: string[];
}
