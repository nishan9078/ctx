import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import type { ProcessResult } from './process-manager.js';
import { liveProcessGroup } from './process-group.js';
import { CtxError } from '../../shared/src/errors.js';
/** Local preparation commands retain existing identity, bounded output, timeout and parent-loss ownership. */
export async function runOwnedCommand(command: string, args: string[], cwd: string, options: { signal?: AbortSignal; timeoutMs?: number; env?: NodeJS.ProcessEnv; onProcess?: (pid: number) => void; onOutput?: (text: string) => void } = {}): Promise<ProcessResult> {
  options.signal?.throwIfAborted();
  if (process.platform !== 'linux') throw new CtxError('ENVIRONMENT_UNAVAILABLE', 'Owned command supervision is currently verified on Linux only');
  const env = { ...(options.env ?? process.env) }; delete env.NODE_TEST_CONTEXT;
  const host = fork(fileURLToPath(new URL('./owned-command-entry.js', import.meta.url)), [], { cwd, env, execArgv: [], detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const pgid = host.pid; let output = ''; let truncated = false; let timedOut = false; let failure: unknown; let stopped = false; let commandCode: number | null | undefined;
  const exited = new Promise<number | null>(resolve => { host.once('exit', code => resolve(code)); host.once('error', error => { failure = error; resolve(null); }); });
  const closed = new Promise<void>(resolve => host.once('close', () => resolve()));
  const collect = (bytes: Buffer) => { const text = bytes.toString(); truncated ||= output.length + text.length > 1000000; output = (output + text).slice(-1000000); try { options.onOutput?.(text); } catch (error) { failure ??= error; stop(); } };
  host.stdout?.on('data', collect); host.stderr?.on('data', collect);
  host.on('message', message => { const frame = message as { type?: string; code?: number | null }; if (frame.type === 'result') commandCode = frame.code; });
  const kill = (signal: NodeJS.Signals) => { if (pgid) try { process.kill(-pgid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') failure ??= error; } };
  const stop = () => { if (stopped) return; stopped = true; if (host.connected) host.send({ type: 'abort' }, () => {}); };
  options.signal?.addEventListener('abort', stop, { once: true });
  const timeout = setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs ?? 120000);
  const escalation = setInterval(() => { if (stopped) kill('SIGKILL'); }, 1500);
  try {
    if (!pgid) { await exited; throw failure ?? new CtxError('ENVIRONMENT_UNAVAILABLE', 'Owned command could not start'); }
    options.onProcess?.(pgid);
    if (options.signal?.aborted) stop();
    else host.send({ type: 'run', command, args }, error => { if (error) { failure ??= error; stop(); } });
    const code = await exited;
    if (liveProcessGroup(pgid).length) { kill('SIGTERM'); await delay(50); while (liveProcessGroup(pgid).length) { kill('SIGKILL'); await delay(20); } }
    await closed;
    if (failure) throw failure;
    return { code: commandCode === undefined ? code : commandCode, output: (truncated ? '[Output truncated to final 1,000,000 characters]\n' : '') + output, truncated, timedOut };
  } catch (error) {
    stop(); kill('SIGKILL'); await exited;
    if (pgid) while (liveProcessGroup(pgid).length) { kill('SIGKILL'); await delay(20); }
    await closed; throw error;
  } finally { clearTimeout(timeout); clearInterval(escalation); options.signal?.removeEventListener('abort', stop); }
}
