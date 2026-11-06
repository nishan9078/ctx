import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodexTurnTracker, normalizeCodexEvent, isRateLimitMessage, type NormalizerHooks } from '../../packages/agents/src/codex-event-normalizer.js';

const ctx = { taskId: 'T-1', attemptId: 'a-1', sequence: 1, timestamp: '2026-11-06T00:00:00.000Z' };
const hooks: NormalizerHooks = { persistCommandOutput: async () => ({ artifactId: 'art-cmd' }) };

test('thread.started captures session id without a canonical event', async () => {
  const tracker = new CodexTurnTracker();
  const result = await normalizeCodexEvent({ type: 'thread.started', thread_id: 'thr_1' }, ctx, tracker, hooks);
  assert.equal(result.kind, 'ignore');
  assert.equal(tracker.sessionId, 'thr_1');
});

test('agent message updates the summary but a turn without terminal is not completed', async () => {
  const tracker = new CodexTurnTracker();
  const result = await normalizeCodexEvent({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'hello' } }, ctx, tracker, hooks);
  assert.equal(result.kind, 'events');
  if (result.kind === 'events') assert.equal(result.events[0]?.type, 'message_delta');
  assert.equal(tracker.summary, 'hello');
  assert.equal(tracker.terminal(), 'none');
});

test('command completion persists output and reports success flag; failures do not hide as success', async () => {
  const tracker = new CodexTurnTracker();
  const ok = await normalizeCodexEvent({ type: 'item.completed', item: { id: 'c1', type: 'command_execution', command: 'echo hi', aggregated_output: 'hi\n', exit_code: 0, status: 'completed' } }, ctx, tracker, hooks);
  if (ok.kind === 'events') {
    assert.equal(ok.events[0]?.type, 'tool_completed');
    assert.equal(ok.events[1]?.type, 'command_executed');
  } else assert.fail('expected events');
  const bad = await normalizeCodexEvent({ type: 'item.completed', item: { id: 'c2', type: 'command_execution', command: 'exit 1', aggregated_output: 'boom', exit_code: 1, status: 'failed' } }, ctx, tracker, hooks);
  assert.equal(tracker.sawToolError, true);
  if (bad.kind === 'events') assert.equal(bad.events[0]?.type, 'tool_completed');
  assert.equal(tracker.commands.length, 2);
});

test('file change and MCP tool events map to files_changed and tool_completed', async () => {
  const tracker = new CodexTurnTracker();
  const file = await normalizeCodexEvent({ type: 'item.completed', item: { id: 'f1', type: 'file_change', changes: [{ path: 'a.ts', kind: 'update' }], status: 'completed' } }, ctx, tracker, hooks);
  if (file.kind === 'events') assert.deepEqual(file.events.map(e => e.type), ['tool_completed', 'files_changed']);
  assert.equal(tracker.sawFileChange, true);
  const mcp = await normalizeCodexEvent({ type: 'item.completed', item: { id: 'm1', type: 'mcp_tool_call', server: 's', tool: 't', arguments: {}, status: 'completed' } }, ctx, tracker, hooks);
  if (mcp.kind === 'events') assert.equal(mcp.events[0]?.type, 'tool_completed');
});

test('turn.completed maps usage; failed turns cannot become success; invalid usage is malformed', async () => {
  const tracker = new CodexTurnTracker();
  await normalizeCodexEvent({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'done-ish' } }, ctx, tracker, hooks);
  await normalizeCodexEvent({ type: 'turn.failed', error: { message: 'boom' } }, ctx, tracker, hooks);
  assert.equal(tracker.summary, 'done-ish');
  assert.equal(tracker.terminal(), 'failed');
  const tracker2 = new CodexTurnTracker();
  const usage = await normalizeCodexEvent({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 2 } }, ctx, tracker2, hooks);
  if (usage.kind === 'events') assert.equal(usage.events[0]?.type, 'usage_reported');
  assert.equal(tracker2.terminal(), 'completed');
  const tracker3 = new CodexTurnTracker();
  const bad = await normalizeCodexEvent({ type: 'turn.completed', usage: { input_tokens: 'many' } }, ctx, tracker3, hooks);
  assert.equal(bad.kind, 'diagnostic');
  assert.equal(tracker3.malformed, true);
});

test('unknown events become bounded diagnostics and do not invalidate the stream', async () => {
  const tracker = new CodexTurnTracker();
  const unknown = await normalizeCodexEvent({ type: 'heuristic.some_future_event', anything: 1 }, ctx, tracker, hooks);
  assert.equal(unknown.kind, 'diagnostic');
  assert.equal(tracker.malformed, false);
  const noType = await normalizeCodexEvent({ nope: true }, ctx, tracker, hooks);
  assert.equal(noType.kind, 'diagnostic');
  assert.equal(tracker.malformed, true);
});

test('rate-limit heuristic matches canonical patterns', () => {
  assert.equal(isRateLimitMessage('Rate limit exceeded, retry later'), true);
  assert.equal(isRateLimitMessage('HTTP 429 Too Many Requests'), true);
  assert.equal(isRateLimitMessage('connection reset'), false);
  assert.equal(isRateLimitMessage(''), false);
});
