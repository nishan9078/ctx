import { SupervisedCodexExecutor } from '../../packages/core/src/supervised-codex-executor.js';
let pgid = 0;
await new SupervisedCodexExecutor({ codexPathOverride: process.argv[2], graceMs: 50 }).run({
  prompt: 'fixture', workspacePath: process.argv[3], signal: new AbortController().signal,
  onProcess(info) { pgid = info.pgid; },
  async onRawEvent(raw) {
    const event = raw as { type: string; item?: { type: string; text: string } };
    if (event.type === 'item.completed' && event.item?.type === 'agent_message') process.send?.({ type: 'running', pgid });
  },
});
