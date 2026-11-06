import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taskFixture, checkpointFixture } from '../fixtures/domain.js';
import { validateTaskSpec, validateCheckpoint, parseTaskSpec, serializeTaskSpec, parseCheckpoint, serializeCheckpoint } from '../../packages/shared/src/validation.js';
import { CtxError, ValidationError } from '../../packages/shared/src/errors.js';
import { taskStates, type TaskState } from '../../packages/shared/src/domain.js';
import { assertTaskTransition, isTerminalState, taskTransitions } from '../../packages/shared/src/transitions.js';
import { assertTransition, assertStepTransition } from '../../packages/core/src/state-machine.js';

test('versioned task/checkpoint round trips preserve work and never retain mutable input references', () => {
  assert.deepEqual(parseTaskSpec(serializeTaskSpec(taskFixture)), taskFixture);
  assert.deepEqual(parseCheckpoint(serializeCheckpoint(checkpointFixture)), checkpointFixture);
  const source = structuredClone(taskFixture); const validated = validateTaskSpec(source);
  source.scope.include.push('foreign/**'); source.acceptance.push('Forged');
  assert.deepEqual(validated, taskFixture);
  assert.deepEqual(validateCheckpoint(checkpointFixture), checkpointFixture);
});
for (const [name, patch] of [
  ['missing version', { schemaVersion: undefined }], ['unknown version', { schemaVersion: 2 }], ['unknown field', { injectedCommand: 'root command' }],
  ['empty title', { title: ' ' }], ['no acceptance', { acceptance: [] }], ['sparse acceptance', { acceptance: new Array(1) }], ['invalid priority', { priority: 'fast' }], ['nonfinite budget', { maxWallMinutes: Infinity }], ['fractional attempts', { maxAttempts: 1.5 }],
  ['zero attempts', { maxAttempts: 0 }], ['duplicate dependencies', { dependsOn: ['CTX-101', 'CTX-101'] }], ['self dependency', { dependsOn: ['CTX-104'] }], ['unsafe scope', { scope: { include: ['../etc/**'], exclude: [] } }],
  ['absolute scope', { scope: { include: ['/tmp/**'], exclude: [] } }], ['Windows traversal', { scope: { include: ['C:\\secret'], exclude: [] } }], ['invalid source', { metadata: { source: 'untrusted', permissions: ['admin'] } }],
] as const) test(`task schema rejects ${name} with actionable safe error`, () => {
  assert.throws(() => validateTaskSpec({ ...taskFixture, ...patch }), error => error instanceof ValidationError && /^task[.:]/.test(error.message));
});
test('invalid JSON and hostile unknown keys cannot leak rejected values in diagnostics', () => {
  const secret = 'fixture-secret-value';
  for (const json of ['{"schemaVersion":', JSON.stringify({ ...taskFixture, [secret]: secret }), 'x'.repeat(1_000_001)]) {
    assert.throws(() => parseTaskSpec(json), error => error instanceof CtxError && !JSON.stringify(error).includes(secret));
  }
  assert.throws(() => validateTaskSpec(Object.assign(Object.create({ privileged: true }), taskFixture)), ValidationError);
});
test('portable serialization redacts known credentials including escaped values without mutating inputs', () => {
  const secret = 'fixture-"quoted"-secret'; const env = { SERVICE_API_KEY: secret };
  const task = { ...taskFixture, objective: `Use ${secret}` };
  const checkpoint = { ...checkpointFixture, decisions: [`Do not expose ${secret}`] };
  assert.equal(parseTaskSpec(serializeTaskSpec(task, env)).objective, 'Use [REDACTED]');
  assert.deepEqual(parseCheckpoint(serializeCheckpoint(checkpoint, env)).decisions, ['Do not expose [REDACTED]']);
  assert.equal(task.objective, `Use ${secret}`);
});
for (const [name, patch] of [
  ['unknown version', { schemaVersion: 8 }], ['unknown field', { permissions: ['admin'] }], ['bad hash', { artifactHashes: { patch: 'wrong' } }], ['prototype key', { artifactHashes: JSON.parse('{"__proto__":"' + 'b'.repeat(64) + '"}') }],
  ['bad base', { baseCommit: 'HEAD' }], ['relative worktree', { worktree: 'workspace' }], ['traversing worktree', { worktree: '/tmp/a/../b' }], ['traversing change', { changedFiles: ['../secret'] }],
  ['bad branch', { branch: 'ctx/task.lock' }], ['unsafe branch', { branch: 'ctx/task@{1}' }], ['foreign session', { sessionRefs: { unknown: 'id' } }], ['invalid verification', { lastVerification: { status: 'success', reason: 'Agent said done' } }],
] as const) test(`checkpoint rejects ${name}`, () => assert.throws(() => validateCheckpoint({ ...checkpointFixture, ...patch }), ValidationError));

test('lifecycle scenarios cover completion, repair, waits, explicit retry and pause', () => {
  const scenarios: TaskState[][] = [
    ['draft', 'queued', 'waiting_dependency', 'ready', 'leased', 'running', 'verifying', 'completed'],
    ['running', 'recovering', 'running', 'verifying', 'recovering', 'blocked', 'queued'],
    ['running', 'waiting_capacity', 'ready', 'leased', 'running', 'waiting_approval', 'ready'],
    ['queued', 'paused', 'queued'], ['waiting_dependency', 'blocked'],
  ];
  for (const path of scenarios) for (let i = 1; i < path.length; i++) assert.doesNotThrow(() => assertTaskTransition(path[i - 1], path[i]));
});
test('completion requires verification, terminal tasks cannot reopen, cancellation covers nonterminal states', () => {
  for (const from of taskStates) {
    if (isTerminalState(from)) {
      for (const to of taskStates) assert.throws(() => assertTaskTransition(from, to), error => error instanceof CtxError && error.code === 'INVALID_TRANSITION');
    } else {
      assert.doesNotThrow(() => assertTaskTransition(from, 'cancelled'));
      assert.throws(() => assertTaskTransition(from, from));
    }
    if (from !== 'verifying') assert.throws(() => assertTaskTransition(from, 'completed'));
  }
  for (const [from, to] of [['queued', 'running'], ['waiting_dependency', 'leased'], ['waiting_approval', 'running'], ['paused', 'running'], ['blocked', 'ready']] as const) assert.throws(() => assertTaskTransition(from, to));
  assert.equal(isTerminalState('blocked'), false);
  assert.throws(() => assertTaskTransition('__proto__' as TaskState, 'queued'));
  assert.throws(() => (taskTransitions.running as TaskState[]).push('completed'));
});
test('existing persisted runner transitions remain compatible and reject unknown runtime states', () => {
  assert.doesNotThrow(() => assertTransition('executing', 'verifying'));
  assert.doesNotThrow(() => assertTransition('executing', 'executing'));
  assert.throws(() => assertTransition('blocked', 'planning'));
  assert.throws(() => assertTransition('invalid' as never, 'invalid' as never));
  assert.throws(() => assertStepTransition('passed', 'running'));
});
