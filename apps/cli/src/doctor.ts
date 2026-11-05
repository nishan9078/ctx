import { runProcess } from '../../../packages/environment/src/process-manager.js';
import { LocalDockerDriver } from '../../../packages/environment/src/docker.js';
import { codexEntrypoint } from './terminal.js';
import { securityWorkerPath } from '../../../packages/security/src/codex-security.adapter.js';
export async function doctor(): Promise<number> {
  const checks: [string, () => Promise<{ code: number | null }>][] = [
    ['Git', () => runProcess('git', ['--version'], process.cwd())],
    ['Docker', () => new LocalDockerDriver().command(['info', '--format', '{{.ServerVersion}}'])],
    ['Execution engine', () => runProcess(process.execPath, [codexEntrypoint(), '--version'], process.cwd())],
    ['Account', () => runProcess(process.execPath, [codexEntrypoint(), 'login', 'status'], process.cwd())],
    ['Security engine', () => runProcess(process.execPath, [securityWorkerPath(), '--check'], process.cwd())],
    ['Python', () => runProcess('python3', ['-c', 'import sys; assert sys.version_info >= (3,10); __import__("tomllib" if sys.version_info >= (3,11) else "tomli")'], process.cwd())],
  ];
  console.log(`CTX readiness\nRuntime: ${process.version}`);
  let unavailable = false;
  for (const [name, check] of checks) {
    try { const result = await check(); console.log(`${name}: ${result.code === 0 ? 'ready' : 'unavailable'}`); unavailable ||= result.code !== 0; }
    catch { console.log(`${name}: unavailable`); unavailable = true; }
  }
  console.log('Security access: not checked; /security starts an explicit scan.');
  return unavailable ? 1 : 0;
}
