import type { Plan, PlanStep } from './types.js';
export function nextStep(plan: Plan): PlanStep | undefined {
  if (plan.steps.some(step => step.status === 'running')) throw new Error('Reconcile running step before scheduling');
  const ids = new Map(plan.steps.map(step => [step.id, step]));
  for (const step of plan.steps) for (const dependency of step.dependencies) if (!ids.has(dependency)) throw new Error(`Unknown step ID: ${dependency}`);
  return plan.steps.find(step => step.status === 'pending' && step.dependencies.every(id => ids.get(id)!.status === 'passed'));
}
