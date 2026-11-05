import type { Plan, PlanStep } from './types.js';
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Plan must contain objects');
  return value as Record<string, unknown>;
}
function nonempty(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
function strings(value: unknown, nonEmpty = false): value is string[] {
  return Array.isArray(value) && (!nonEmpty || value.length > 0) && value.every(nonempty) && new Set(value).size === value.length;
}
export function validatePlan(input: unknown): Plan {
  const plan = object(input);
  if (plan.version !== 1 || !Array.isArray(plan.steps) || plan.steps.length === 0 || plan.steps.length > 100) throw new Error('Plan requires version 1 and 1–100 steps');
  const steps: PlanStep[] = plan.steps.map(value => {
    const step = object(value);
    if (!nonempty(step.id) || !/^[a-zA-Z0-9_-]{1,80}$/.test(step.id) || !nonempty(step.title) || !nonempty(step.instructions)
      || !strings(step.dependencies) || !strings(step.acceptanceCriteria, true) || (step.status !== undefined && step.status !== 'pending')) throw new Error('Invalid plan step schema');
    return { id: step.id, title: step.title, instructions: step.instructions, dependencies: step.dependencies, acceptanceCriteria: step.acceptanceCriteria, status: 'pending' };
  });
  const ids = new Set(steps.map(step => step.id));
  if (ids.size !== steps.length) throw new Error('Duplicate step IDs');
  for (const step of steps) for (const dep of step.dependencies) if (!ids.has(dep)) throw new Error(`Missing dependency: ${dep}`);
  const visiting = new Set<string>(); const visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error('Cyclic plan dependencies');
    if (visited.has(id)) return;
    visiting.add(id); for (const dep of steps.find(step => step.id === id)!.dependencies) visit(dep);
    visiting.delete(id); visited.add(id);
  };
  steps.forEach(step => visit(step.id));
  return { version: 1, steps };
}
export function createPlan(request: string): Plan {
  return validatePlan({ version: 1, steps: [{ id: 'implement', title: 'Implement request', instructions: request, dependencies: [], acceptanceCriteria: ['Implement the request and preserve existing behavior; required build and tests pass.'] }] });
}
