import { integer, record, keys } from './validation.js';
export interface WorkerRuntimeBudget {
  maxWallMs: number; maxRssBytes: number; maxCpuMs: number; maxWorkspaceBytes: number;
  minFreeDiskBytes: number; minAvailableMemoryBytes: number; sampleMs: number;
}
export interface RuntimeHealth {
  timestamp: string; pids: number[]; rssBytes: number; observedCpuMs: number;
  workspaceBytes: number; freeDiskBytes: number; availableMemoryBytes: number;
}
export const defaultWorkerRuntimeBudget: Readonly<WorkerRuntimeBudget> = Object.freeze({
  maxWallMs: 90 * 60000, maxRssBytes: 2 * 1024 ** 3, maxCpuMs: 3600000, maxWorkspaceBytes: 2 * 1024 ** 3,
  minFreeDiskBytes: 10 * 1024 ** 3, minAvailableMemoryBytes: 128 * 1024 ** 2, sampleMs: 1000,
});
export function workerRuntimeBudget(input: Partial<WorkerRuntimeBudget> = {}): WorkerRuntimeBudget {
  const value = record(input, 'runtimeBudget'); keys(value, Object.keys(defaultWorkerRuntimeBudget), 'runtimeBudget');
  return Object.fromEntries(Object.entries(defaultWorkerRuntimeBudget).map(([key, fallback]) => [key, integer(value[key] ?? fallback, key === 'sampleMs' ? 50 : 1, key === 'sampleMs' ? 60000 : Number.MAX_SAFE_INTEGER, `runtimeBudget.${key}`)])) as unknown as WorkerRuntimeBudget;
}

export function runtimeBudgetFromConfig(runtime: import('./config.js').CtxConfig['runtime']): WorkerRuntimeBudget {
  return workerRuntimeBudget({ maxWallMs: runtime.maxAttemptWallMinutes * 60000, maxRssBytes: runtime.maxWorkerRssMb * 1024 ** 2, maxCpuMs: runtime.maxWorkerCpuSeconds * 1000, maxWorkspaceBytes: runtime.maxWorkspaceMb * 1024 ** 2, minFreeDiskBytes: runtime.diskFreeMinGb * 1024 ** 3 });
}
