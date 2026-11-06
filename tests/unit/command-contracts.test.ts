import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CommandBus, CommandContext, CommandInputs, CommandOutputs } from '../../packages/core/src/commands.js';
import type { WorkerEvent, TaskState } from '../../packages/shared/src/domain.js';
import { taskFixture } from '../fixtures/domain.js';
import { CtxError } from '../../packages/shared/src/errors.js';

// Compile-time interface probes: intentionally never invoke a fake command handler.
async function checkCommandTypes(bus: CommandBus, context: CommandContext): Promise<void> {
  const response = await bus.execute('submit', { spec: taskFixture, deduplicationKey: 'source-event' }, context);
  if (response.ok) { const state: TaskState = response.value.task.state; void state; }
  // @ts-expect-error Raw request text is not a validated TaskSpec.
  await bus.execute('submit', { spec: 'run as root', deduplicationKey: 'source-event' }, context);
  // @ts-expect-error Approval requires both an action hash and expected task revision.
  await bus.execute('approve', { taskId: 'CTX-104', approvalId: 'approval-1', decision: 'approved' }, context);
  const query = await bus.execute('query', { limit: 20 }, context);
  if (query.ok) {
    // @ts-expect-error Query results cannot be mistaken for submission acknowledgements.
    const incorrect: CommandOutputs['submit'] = query.value;
    void incorrect;
  }
}
void checkCommandTypes;
const commandNames: { [K in keyof CommandInputs]: K extends keyof CommandOutputs ? K : never } = {
  submit: 'submit', cancel: 'cancel', pause: 'pause', resume: 'resume', approve: 'approve', retry: 'retry', query: 'query',
};
function workerEventKind(event: WorkerEvent): string {
  switch (event.type) {
    case 'started': return event.harnessId;
    case 'message_delta': return event.text;
    case 'tool_started': return event.name;
    case 'tool_completed': return String(event.success);
    case 'command_executed': return event.artifactId;
    case 'files_changed': return event.paths.join(',');
    case 'permission_requested': return event.approval.actionHash;
    case 'usage_reported': return String(event.inputTokens);
    case 'rate_limited': return event.capacity.providerKey;
    case 'failed': return event.code;
    case 'completed': return event.summary;
    case 'interrupted': return event.reason;
    default: { const unreachable: never = event; return unreachable; }
  }
}
void workerEventKind;
test('commands expose all required operations and structured errors serialize without stack data', () => {
  assert.equal(Object.keys(commandNames).length, 7);
  assert.deepEqual(new CtxError('RATE_LIMIT', 'Provider cooling down', true).toJSON(), { code: 'RATE_LIMIT', message: 'Provider cooling down', retryable: true });
});
