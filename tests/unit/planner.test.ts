import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePlan } from '../../packages/core/src/planner.js';
import { nextStep } from '../../packages/core/src/scheduler.js';
import { assertTransition } from '../../packages/core/src/state-machine.js';
const step = (id: string, dependencies: string[] = []) => ({ id, title: id, instructions: `Do ${id}`, dependencies, acceptanceCriteria: ['Tests pass'] });
test('validates DAG and schedules only after prerequisites pass', () => {
  const plan = validatePlan({ version: 1, steps: [step('second', ['first']), step('first')] });
  assert.equal(nextStep(plan)?.id, 'first');
  plan.steps[1].status = 'running'; assert.throws(() => nextStep(plan), /Reconcile/);
  plan.steps[1].status = 'passed'; assert.equal(nextStep(plan)?.id, 'second');
  plan.steps[1].status = 'failed'; assert.equal(nextStep(plan), undefined);
});
for (const [name, steps] of [
  ['duplicate', [step('a'), step('a')]], ['missing dependency', [step('a', ['missing'])]],
  ['cycle', [step('a', ['b']), step('b', ['a'])]], ['self cycle', [step('a', ['a'])]],
  ['empty acceptance', [{ ...step('a'), acceptanceCriteria: [] }]],
  ['forged state', [{ ...step('a'), status: 'passed' }]], ['invalid instructions', [{ ...step('a'), instructions: 7 }]],
] as const) test(`rejects ${name}`, () => assert.throws(() => validatePlan({ version: 1, steps })));
test('rejects unknown scheduler dependency IDs and illegal transitions', () => {
  assert.throws(() => nextStep({ version: 1, steps: [{ ...step('a', ['missing']), status: 'pending' }] }), /Unknown/);
  assert.throws(() => assertTransition('completed', 'executing'), /Invalid/);
  assert.throws(() => assertTransition('queued', 'completed'), /Invalid/);
  assert.doesNotThrow(() => assertTransition('verifying', 'repairing'));
});
