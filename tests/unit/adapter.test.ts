import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodexSdkAdapter, type CodexClient } from '../../packages/agents/src/codex-sdk.adapter.js';
function fake(events: unknown[], fail = false) {
  const calls: unknown[] = [];
  const thread = { async runStreamed() { return { events: (async function* () { for (const e of events) yield e; if (fail) throw new Error('transport lost'); })() }; } };
  const client = { startThread(options: unknown) { calls.push(options); return thread; }, resumeThread(id: string, options: unknown) { calls.push({ id, options }); return thread; } } as unknown as CodexClient;
  return { adapter: new CodexSdkAdapter(client), calls };
}
const usage = { input_tokens: 10, output_tokens: 2 };
test('captures streamed events, final summary, usage and sandbox options', async () => {
  const events = [{ type: 'thread.started', thread_id: 'session-1' }, { type: 'item.completed', item: { type: 'agent_message', text: 'Done' } }, { type: 'turn.completed', usage }];
  const { adapter, calls } = fake(events); const captured: unknown[] = [];
  const result = await adapter.execute({ prompt: 'feature', workspacePath: '/tmp/fixture', onEvent: async event => { captured.push(event); } });
  assert.equal(result.outcome, 'completed'); assert.equal(result.sessionId, 'session-1'); assert.equal(result.summary, 'Done'); assert.deepEqual(result.usage, usage); assert.equal(captured.length, 3);
  assert.equal((calls[0] as { sandboxMode: string }).sandboxMode, 'workspace-write');
});
test('resumes a session', async () => {
  const { adapter, calls } = fake([{ type: 'turn.completed', usage }]);
  await adapter.execute({ prompt: 'continue', workspacePath: '/tmp/fixture', sessionId: 'prior' });
  assert.equal((calls[0] as { id: string }).id, 'prior');
});
for (const [name, events, fail] of [
  ['truncated stream', [], false], ['turn failure', [{ type: 'turn.failed', error: { message: 'denied' } }], false],
  ['transport failure', [], true], ['malformed event', [null], false], ['invalid usage', [{ type: 'turn.completed', usage: { output_tokens: -1 } }], false],
] as const) test(name, async () => {
  const { adapter } = fake([...events], fail); assert.equal((await adapter.execute({ prompt: 'x', workspacePath: '/tmp' })).outcome, 'failed');
});
test('cancellation does not launch a thread', async () => {
  const { adapter, calls } = fake([]);
  const result = await adapter.execute({ prompt: 'x', workspacePath: '/tmp', signal: AbortSignal.abort() });
  assert.equal(result.outcome, 'interrupted'); assert.equal(calls.length, 0);
});
