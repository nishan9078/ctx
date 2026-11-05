import { spawn } from 'node:child_process';
export interface ProcessResult { code: number | null; output: string; timedOut: boolean; truncated: boolean }
export async function runProcess(command: string, args: string[], cwd: string, options: {
  signal?: AbortSignal; timeoutMs?: number; onOutput?: (text: string) => void;
} = {}): Promise<ProcessResult> {
  if (options.signal?.aborted) throw new Error('Operation cancelled');
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(command, args, { cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; let timedOut = false; let truncated = false; let killTimer: NodeJS.Timeout | undefined;
    const stop = () => {
      const kill = (signal: NodeJS.Signals) => {
        try { if (process.platform !== 'win32') process.kill(-child.pid!, signal); else child.kill(signal); } catch { /* Already exited. */ }
      };
      kill('SIGTERM'); killTimer = setTimeout(() => kill('SIGKILL'), 1000); killTimer.unref();
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs ?? 120_000);
    const collect = (data: Buffer) => { const text = data.toString(); truncated ||= output.length + text.length > 1_000_000; output = (output + text).slice(-1_000_000); options.onOutput?.(text); };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    options.signal?.addEventListener('abort', stop, { once: true });
    const cleanup = () => { clearTimeout(timer); if (killTimer) clearTimeout(killTimer); options.signal?.removeEventListener('abort', stop); };
    child.on('error', error => { cleanup(); reject(error); });
    child.on('close', code => { cleanup(); resolve({ code, output: (truncated ? '[Output truncated to final 1,000,000 characters]\n' : '') + output, timedOut, truncated }); });
  });
}
