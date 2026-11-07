import { readFile, readdir, lstat, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { CtxError } from '../../shared/src/errors.js';
import type { RuntimeHealth, WorkerRuntimeBudget } from '../../shared/src/runtime.js';
import { liveProcessGroup } from './process-group.js';
import { safeDirectory } from './path-safety.js';
import { runProcess } from './process-manager.js';
export async function directoryBytes(root: string): Promise<number> {
  await safeDirectory(root); let bytes = 0; let count = 0;
  async function visit(path: string) {
    for (const entry of await readdir(path)) {
      if (++count > 100000) throw new CtxError('BUDGET_EXHAUSTED', 'Workspace exceeds runtime file-count budget');
      const file = join(path, entry); let stat;
      try { stat = await lstat(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      if (stat.isSymbolicLink()) throw new CtxError('UNAUTHORIZED', 'Workspace gained a symlink during execution');
      if (stat.isDirectory()) await visit(file); else if (stat.isFile()) bytes += stat.size; else throw new CtxError('UNAUTHORIZED', 'Workspace gained a special file during execution');
    }
  }
  await visit(root); return bytes;
}
/** CPU is accumulated from observed /proc process deltas, not an exact cgroup charge. */
export class RuntimeSampler {
  private clockTicks?: number;
  private readonly ticks = new Map<string, number>();
  private observedCpuMs = 0;
  async sample(storage: string, root?: string, pgid?: number): Promise<RuntimeHealth> {
    await safeDirectory(storage);
    if (!this.clockTicks && pgid) {
      const result = await runProcess('getconf', ['CLK_TCK'], storage);
      if (result.code !== 0 || !/^[1-9][0-9]*$/.test(result.output.trim())) throw new CtxError('ENVIRONMENT_UNAVAILABLE', 'Cannot establish process CPU clock rate');
      this.clockTicks = Number(result.output.trim());
    }
    const memory = await readFile('/proc/meminfo', 'utf8'); const available = /^MemAvailable:\s+(\d+) kB$/m.exec(memory);
    if (!available) throw new CtxError('ENVIRONMENT_UNAVAILABLE', 'Available system memory cannot be measured');
    const disk = await statfs(storage); const pids = pgid ? liveProcessGroup(pgid) : []; let rssBytes = 0;
    for (const pid of pids) {
      try {
        const [stat, status] = await Promise.all([readFile(`/proc/${pid}/stat`, 'utf8'), readFile(`/proc/${pid}/status`, 'utf8')]);
        const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/); const cpu = Number(fields[11]) + Number(fields[12]); const key = `${pid}:${fields[19]}`;
        this.observedCpuMs += Math.max(0, cpu - (this.ticks.get(key) ?? 0)) * 1000 / this.clockTicks!; this.ticks.set(key, cpu);
        const rss = /^VmRSS:\s+(\d+) kB$/m.exec(status); if (rss) rssBytes += Number(rss[1]) * 1024;
      } catch (error) { if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) throw new CtxError('ENVIRONMENT_UNAVAILABLE', 'Worker resource measurement is unavailable'); }
    }
    return { timestamp: new Date().toISOString(), pids, rssBytes, observedCpuMs: this.observedCpuMs, workspaceBytes: root ? await directoryBytes(root) : 0, freeDiskBytes: disk.bavail * disk.bsize, availableMemoryBytes: Number(available[1]) * 1024 };
  }
}
export function enforceRuntimeBudget(health: RuntimeHealth, budget: WorkerRuntimeBudget): void {
  const violation = health.freeDiskBytes < budget.minFreeDiskBytes ? 'free disk' : health.availableMemoryBytes < budget.minAvailableMemoryBytes ? 'available memory' : health.rssBytes > budget.maxRssBytes ? 'worker RSS' : health.observedCpuMs > budget.maxCpuMs ? 'observed CPU' : health.workspaceBytes > budget.maxWorkspaceBytes ? 'workspace disk' : undefined;
  if (violation) throw new CtxError('BUDGET_EXHAUSTED', `Runtime budget exceeded: ${violation}`);
}
