import type { WorkerEvent } from '../../shared/src/domain.js';

/**
 * Canonical translation of Codex SDK events into WorkerEvent values (P04-03).
 *
 * Queue business logic never sees provider payloads: every SDK event is
 * translated here into a canonical event or a bounded diagnostic. Unknown
 * additive SDK event types become diagnostics; they never fabricate success
 * and never abort an otherwise valid stream.
 *
 * Terminal semantics (drives the bridge's outcome mapping):
 * - an agent message alone is NOT success;
 * - a stream ending without a valid terminal turn event is incomplete;
 * - a failed turn cannot become success because it also produced text;
 * - a completed harness turn is NOT a passed engineering verification.
 */
export interface NormalizerContext {
  taskId: string; attemptId: string; sequence: number; timestamp: string;
}
export interface CommandOutputPersisted { artifactId: string }
export interface NormalizerHooks {
  persistCommandOutput(input: { toolId: string; command: string; output: string; exitCode: number | null }): Promise<CommandOutputPersisted>;
}
export type NormalizedOutput =
  | { kind: 'events'; events: WorkerEvent[] }
  | { kind: 'diagnostic'; type: string; payload: unknown }
  | { kind: 'ignore' };

export class CodexTurnTracker {
  sessionId?: string;
  summary = '';
  usage?: { inputTokens: number; outputTokens: number; extra: Record<string, number> };
  sawTurnCompleted = false;
  failed = false;
  errorMessage = '';
  sawFileChange = false;
  sawToolError = false;
  malformed = false;
  rawCount = 0;
  commands: { toolId: string; command: string; exitCode: number | null; artifactId?: string }[] = [];
  terminal(): 'completed' | 'failed' | 'none' {
    if (this.sawTurnCompleted) return this.failed ? 'failed' : 'completed';
    return this.failed ? 'failed' : 'none';
  }
}

const knownTypes = new Set(['thread.started', 'turn.started', 'turn.completed', 'turn.failed', 'item.started', 'item.updated', 'item.completed', 'error']);

const asObject = (value: unknown): Record<string, unknown> | undefined =>
  (typeof value === 'object' && value !== null && !Array.isArray(value)) ? value as Record<string, unknown> : undefined;
const asString = (value: unknown): string | undefined => (typeof value === 'string' && value.length > 0) ? value : undefined;
const asNumber = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) && value >= 0) ? value : undefined;

const diagnostic = (rawType: string, payload: unknown): NormalizedOutput => ({ kind: 'diagnostic', type: rawType, payload });
type WorkerEventBody =
  | { type: 'started'; harnessId: 'codex'; sessionId?: string }
  | { type: 'message_delta'; text: string }
  | { type: 'tool_started'; toolId: string; name: string }
  | { type: 'tool_completed'; toolId: string; success: boolean }
  | { type: 'command_executed'; command: string; exitCode: number | null; artifactId: string }
  | { type: 'files_changed'; paths: string[] }
  | { type: 'permission_requested'; approval: never }
  | { type: 'usage_reported'; inputTokens: number; outputTokens: number; costUsd?: number }
  | { type: 'rate_limited'; capacity: never }
  | { type: 'failed'; code: never; message: string; retryable: boolean }
  | { type: 'completed'; summary: string; artifactIds: string[] }
  | { type: 'interrupted'; reason: string };
const make = (ctx: NormalizerContext, body: WorkerEventBody): WorkerEvent =>
  ({ taskId: ctx.taskId, attemptId: ctx.attemptId, sequence: ctx.sequence, timestamp: ctx.timestamp, ...body }) as WorkerEvent;

async function handleItem(ctx: NormalizerContext, event: Record<string, unknown>, phase: 'started' | 'completed', tracker: CodexTurnTracker, hooks: NormalizerHooks): Promise<NormalizedOutput> {
  const item = asObject(event.item);
  if (!item || typeof item.type !== 'string') { tracker.malformed = true; return diagnostic('malformed', { reason: 'invalid-sdk-item', type: String(event.type) }); }
  const kind = item.type;
  if (phase === 'started') {
    if (kind === 'command_execution' || kind === 'file_change' || kind === 'mcp_tool_call' || kind === 'web_search') {
      const toolId = asString(item.id) ?? 'unknown-tool';
      const name = kind === 'mcp_tool_call' ? (asString(item.tool) ?? 'mcp_tool_call') : kind;
      return { kind: 'events', events: [make(ctx, { type: 'tool_started', toolId, name })] };
    }
    return { kind: 'ignore' }; // agent_message / reasoning / todo_list / error started: nothing canonical yet
  }
  // item.completed
  switch (kind) {
    case 'agent_message': {
      const text = item.text as unknown;
      if (typeof text !== 'string') { tracker.malformed = true; return diagnostic('malformed', { reason: 'invalid-agent-message' }); }
      tracker.summary = text;
      return { kind: 'events', events: [make(ctx, { type: 'message_delta', text })] };
    }
    case 'command_execution': {
      const id = asString(item.id) ?? 'unknown-command';
      const command = typeof item.command === 'string' ? item.command : '(unknown command)';
      const output = typeof item.aggregated_output === 'string' ? item.aggregated_output : '';
      const exitCode = (item.exit_code !== undefined && item.exit_code !== null) ? (typeof item.exit_code === 'number' && Number.isFinite(item.exit_code) ? item.exit_code : null) : null;
      const ok = item.status === 'completed';
      if (!ok) tracker.sawToolError = true;
      const events: WorkerEvent[] = [make(ctx, { type: 'tool_completed', toolId: id, success: ok })];
      let artifactId: string | undefined;
      try { artifactId = (await hooks.persistCommandOutput({ toolId: id, command, output, exitCode })).artifactId; }
      catch { tracker.malformed = true; return { kind: 'events', events }; } // artifact failure must not fabricate a command record
      if (artifactId) events.push(make(ctx, { type: 'command_executed', command, exitCode, artifactId }));
      tracker.commands.push({ toolId: id, command, exitCode, artifactId });
      return { kind: 'events', events };
    }
    case 'file_change': {
      const id = asString(item.id) ?? 'unknown-file-change';
      const changes = Array.isArray(item.changes) ? item.changes : [];
      const paths: string[] = [];
      for (const change of changes) { const record = asObject(change); const path = record && asString(record.path); if (path !== undefined) paths.push(path); }
      if (changes.length > 0 && paths.length === 0) { tracker.malformed = true; return diagnostic('malformed', { reason: 'invalid-file-change' }); }
      const ok = item.status === 'completed';
      if (!ok) tracker.sawToolError = true;
      tracker.sawFileChange = true;
      return { kind: 'events', events: [make(ctx, { type: 'tool_completed', toolId: id, success: ok }), ...(paths.length ? [make(ctx, { type: 'files_changed', paths })] : [])] };
    }
    case 'mcp_tool_call': {
      const id = asString(item.id) ?? 'unknown-mcp-call';
      const ok = item.status === 'completed';
      if (!ok) tracker.sawToolError = true;
      return { kind: 'events', events: [make(ctx, { type: 'tool_completed', toolId: id, success: ok })] };
    }
    case 'web_search': {
      const id = asString(item.id) ?? 'unknown-search';
      return { kind: 'events', events: [make(ctx, { type: 'tool_completed', toolId: id, success: true })] };
    }
    case 'error': {
      const message = typeof item.message === 'string' ? item.message : 'Unknown item error';
      tracker.sawToolError = true; tracker.errorMessage = message;
      return diagnostic('item.error', { message });
    }
    default:
      return diagnostic(kind, { reason: 'unmapped-item-kind' });
  }
}

export async function normalizeCodexEvent(raw: unknown, ctx: NormalizerContext, tracker: CodexTurnTracker, hooks: NormalizerHooks): Promise<NormalizedOutput> {
  tracker.rawCount++;
  const event = asObject(raw);
  const type = event && asString(event.type);
  if (!event || !type) { tracker.malformed = true; return diagnostic('malformed', { reason: 'not-an-sdk-event', value: typeof raw === 'string' ? raw.slice(0, 200) : typeof raw }); }
  if (!knownTypes.has(type)) return diagnostic(type, { reason: 'unknown-sdk-event' });
  switch (type) {
    case 'thread.started': {
      const threadId = asString((event as { thread_id?: unknown }).thread_id);
      if (!threadId) { tracker.malformed = true; return diagnostic('malformed', { reason: 'invalid-thread-id' }); }
      tracker.sessionId = threadId;
      return { kind: 'ignore' }; // session persistence is done by the bridge when the ID first appears
    }
    case 'turn.started':
      return diagnostic('turn.started', {});
    case 'turn.completed': {
      const usage = asObject((event as { usage?: unknown }).usage);
      const keys = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens'];
      const numbers: Record<string, number> = {};
      let ok = true;
      for (const key of keys) { const value = usage && asNumber(usage[key]); if (value === undefined) { ok = false; break; } numbers[key] = value; }
      if (!ok || !usage) { tracker.malformed = true; return diagnostic('malformed', { reason: 'invalid-usage' }); }
      tracker.sawTurnCompleted = true;
      tracker.usage = { inputTokens: numbers.input_tokens, outputTokens: numbers.output_tokens, extra: Object.fromEntries(Object.entries(numbers).filter(([k]) => k !== 'input_tokens' && k !== 'output_tokens')) };
      return { kind: 'events', events: [make(ctx, { type: 'usage_reported', inputTokens: numbers.input_tokens, outputTokens: numbers.output_tokens })] };
    }
    case 'turn.failed': {
      const error = asObject((event as { error?: unknown }).error);
      const message = error && typeof error.message === 'string' ? error.message : 'Codex turn failed';
      tracker.failed = true; tracker.errorMessage = message;
      return diagnostic('turn.failed', { message });
    }
    case 'error': {
      const message = typeof (event as { message?: unknown }).message === 'string' ? (event as { message: string }).message : 'Codex stream error';
      tracker.failed = true; tracker.errorMessage = message;
      return diagnostic('error', { message });
    }
    case 'item.started': return handleItem(ctx, event, 'started', tracker, hooks);
    case 'item.completed': return handleItem(ctx, event, 'completed', tracker, hooks);
    case 'item.updated': return { kind: 'ignore' }; // progress-only updates are out of canonical scope
    default: return diagnostic(type, { reason: 'unknown-sdk-event' });
  }
}

/** Heuristic classification, constrained to observable text only. */
export function isRateLimitMessage(message: string): boolean {
  return /(?:rate.?limit|too many requests|429|quota|capacity|try again later)/i.test(message);
}
