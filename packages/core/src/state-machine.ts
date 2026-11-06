// Compatibility facade for persisted v0 task/step states.
export { assertTransition, assertStepTransition, terminal } from '../../shared/src/legacy-transitions.js';
export { assertTaskTransition, taskTransitions, isTerminalState } from '../../shared/src/transitions.js';
