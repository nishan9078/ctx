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
export async function verify(workspace: string, artifacts: string, commands: { build?: string; test?: string }, signal?: AbortSignal, timeoutMs?: number): Promise<CheckResult[]> {
  const checks: CheckResult[] = [];
  for (const name of ['build', 'test'] as const) {
    const started = Date.now(); const command = commands[name]; const artifact = join(artifacts, `${name}.log`);
    if (!command) {
      await writeFile(artifact, 'No verification command configured.\n');
      checks.push({ name, command: '', status: 'unavailable', exitCode: null, durationMs: 0, artifact }); continue;
    }
    let output = ''; let exitCode: number | null = null; let passed = false;
    try {
      const result = await runProcess('/bin/sh', ['-c', command], workspace, { signal, timeoutMs });
      output = result.output + (result.timedOut ? '\nCheck timed out.\n' : ''); exitCode = result.code; passed = result.code === 0 && !result.timedOut;
    } catch (error) { output = String(error); }
    await writeFile(artifact, redact(output));
    checks.push({ name, command, status: signal?.aborted ? 'cancelled' : passed ? 'passed' : 'failed', exitCode, durationMs: Date.now() - started, artifact });
  }
  return checks;
}
