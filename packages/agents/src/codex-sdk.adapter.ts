import { Codex, type ThreadOptions, type ThreadEvent } from '@openai/codex-sdk';
import type { AgentAdapter, AgentInput, AgentResult } from './agent-adapter.js';
export type CodexClient = Pick<Codex, 'startThread' | 'resumeThread'>;
export class CodexSdkAdapter implements AgentAdapter {
  constructor(private readonly client: CodexClient = new Codex({ env: Object.fromEntries(Object.entries(process.env).filter(([key, value]) => key !== 'NODE_TEST_CONTEXT' && value !== undefined)) as Record<string, string> }), private readonly model?: string) {}
  async execute(input: AgentInput): Promise<AgentResult> {
    let sessionId = input.sessionId;
    let summary = ''; let completed = false; let failed = false;
    let usage: Record<string, number> | undefined;
    try {
      if (input.signal?.aborted) return { sessionId, outcome: 'interrupted', summary: 'Cancelled before execution' };
      const options: ThreadOptions = {
        workingDirectory: input.workspacePath, sandboxMode: 'workspace-write', approvalPolicy: 'never',
        networkAccessEnabled: false, webSearchMode: 'disabled', model: this.model,
      };
      const thread = sessionId ? this.client.resumeThread(sessionId, options) : this.client.startThread(options);
      const { events } = await thread.runStreamed(input.prompt, { signal: input.signal });
      for await (const raw of events) {
        // Runtime guard even though SDK declares this stream statically.
        if (!raw || typeof raw !== 'object' || typeof raw.type !== 'string') throw new Error('Malformed SDK event');
        const event: ThreadEvent = raw;
        await input.onEvent?.({ type: event.type, data: event });
        switch (event.type) {
          case 'thread.started':
            if (typeof event.thread_id !== 'string' || !event.thread_id) throw new Error('Invalid SDK session ID');
            sessionId = event.thread_id; break;
          case 'item.completed':
            if (!event.item || typeof event.item.type !== 'string') throw new Error('Invalid SDK item');
            if (event.item.type === 'agent_message') {
              if (typeof event.item.text !== 'string') throw new Error('Invalid SDK summary');
              summary = event.item.text;
            }
            break;
          case 'turn.completed':
            if (!event.usage || typeof event.usage.input_tokens !== 'number' || typeof event.usage.output_tokens !== 'number' || Object.values(event.usage).some(value => typeof value !== 'number' || !Number.isFinite(value) || value < 0)) throw new Error('Invalid SDK usage');
            usage = { ...event.usage }; completed = true; break;
          case 'turn.failed': failed = true; summary = event.error.message; break;
          case 'error': failed = true; summary = event.message; break;
        }
      }
      return { sessionId, outcome: input.signal?.aborted ? 'interrupted' : completed && !failed ? 'completed' : 'failed', summary: summary || 'SDK stream ended without a final response', usage };
    } catch (error) {
      return { sessionId, outcome: input.signal?.aborted ? 'interrupted' : 'failed', summary: String(error), usage };
    }
  }
}
