import type { CommandRunner } from '../../environment/src/types.js';
import { EnvironmentUnavailable } from '../../environment/src/types.js';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CheckResult } from '../../shared/src/contracts.js';
import { redact } from '../../shared/src/redact.js';
import { runProcess } from '../../environment/src/process-manager.js';
export async function discoverCommands(repo: string, overrides: { build?: string; test?: string }): Promise<{ build?: string; test?: string }> {
  let scripts: Record<string, unknown> = {};
  try { scripts = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8')).scripts ?? {}; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return {
    build: overrides.build ?? (typeof scripts.build === 'string' ? 'npm run build' : undefined),
    test: overrides.test ?? (typeof scripts.test === 'string' ? 'npm test' : undefined),
  };
}
export async function verify(workspace: string, artifacts: string, commands: { build?: string; test?: string }, signal?: AbortSignal, timeoutMs?: number, hooks?: { existing?: CheckResult[]; before?: (name: string) => void; after?: (check: CheckResult) => void }, runner?: CommandRunner): Promise<CheckResult[]> {
  const checks: CheckResult[] = [];
  for (const name of ['build', 'test'] as const) {
    const existing = hooks?.existing?.find(check => check.name === name);
    if (existing) { checks.push(existing); continue; }
    hooks?.before?.(name);
    const started = Date.now(); const command = commands[name]; const artifact = join(artifacts, `${name}.log`);
    if (!command) {
      await writeFile(artifact, 'No verification command configured.\n');
      const check: CheckResult = { name, command: '', status: 'unavailable', exitCode: null, durationMs: 0, artifact };
      checks.push(check); hooks?.after?.(check); continue;
    }
    let output = ''; let exitCode: number | null = null; let passed = false; let infrastructureError: EnvironmentUnavailable | undefined;
    try {
      const result = runner ? await runner.run(command, signal, timeoutMs) : await runProcess('/bin/sh', ['-c', command], workspace, { signal, timeoutMs });
      output = result.output + (result.timedOut ? '\nCheck timed out.\n' : ''); exitCode = result.code; passed = result.code === 0 && !result.timedOut;
    } catch (error) { output = String(error); if (error instanceof EnvironmentUnavailable) infrastructureError = error; }
    await writeFile(artifact, redact(output));
    const check: CheckResult = { name, command, status: signal?.aborted ? 'cancelled' : infrastructureError ? 'unavailable' : passed ? 'passed' : 'failed', exitCode, durationMs: Date.now() - started, artifact };
    checks.push(check); hooks?.after?.(check);
    // A broken control plane is not an application failure for the coding agent
    // to repair, nor permission to retry from a different execution context.
    if (infrastructureError) throw infrastructureError;
  }
  return checks;
}
