export interface AgentEvent {
  type: string;
  data: unknown;
}
export interface AgentInput {
  prompt: string;
  workspacePath: string;
  sessionId?: string;
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => Promise<void>;
}
export interface AgentResult {
  sessionId?: string;
  outcome: 'completed' | 'failed' | 'interrupted';
  summary: string;
  usage?: Record<string, number>;
}
export interface AgentAdapter {
  execute(input: AgentInput): Promise<AgentResult>;
}
