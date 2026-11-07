import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { liveProcessGroup } from './process-group.js';
import { CtxError } from '../../shared/src/errors.js';
import type { ProcessResult } from './process-manager.js';
/** One scoped parent-loss-protected host; requests are serialized and no host survives scope close. */
export class OwnedCommandSession {
  private host?: ChildProcess;
  private exited?: Promise<void>;
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private sequence = 0;
  private pending?: { id: number; resolve: (result: ProcessResult) => void; reject: (error: unknown) => void };
  constructor(private readonly options: { env?: NodeJS.ProcessEnv; onProcess?: (pid: number) => void } = {}) {}
  private start(cwd: string): ChildProcess {
    if (this.host) return this.host;
    if (process.platform !== 'linux') throw new CtxError('ENVIRONMENT_UNAVAILABLE', 'Owned command sessions require verified Linux supervision');
    const env = { ...(this.options.env ?? process.env) }; delete env.NODE_TEST_CONTEXT;
    const host = fork(fileURLToPath(new URL('./owned-command-entry.js', import.meta.url)), [], { cwd, env, execArgv: [], detached: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    host.stderr?.on('data', () => {}); this.host = host;
    this.exited = new Promise<void>(resolve => { host.once('exit', () => { this.closed = true; this.pending?.reject(new CtxError('ENVIRONMENT_UNAVAILABLE', 'Owned command session exited')); resolve(); }); host.once('error', error => { this.closed = true; this.pending?.reject(error); resolve(); }); });
    host.on('message', message => {
      const frame = message as { type: string; requestId: number; code: number | null; output: string; truncated: boolean };
      if (frame.type !== 'result' || frame.requestId !== this.pending?.id) return;
      this.pending.resolve({ code: frame.code, output: (frame.truncated ? '[Output truncated to final 1,000,000 characters]\n' : '') + frame.output, truncated: frame.truncated, timedOut: false });
    });
    if (host.pid) this.options.onProcess?.(host.pid);
    return host;
  }
  run(command: string, args: string[], cwd: string, signal?: AbortSignal): Promise<ProcessResult> {
    const request = this.tail.catch(() => {}).then(async () => {
      signal?.throwIfAborted(); if (this.closed) throw new CtxError('CANCELLED', 'Owned command session is closed');
      const host = this.start(cwd); const id = ++this.sequence;
      let abort: (() => void) | undefined;
      const timeout = setTimeout(() => abort?.(), 120000);
      let escalation: NodeJS.Timeout | undefined;
      try {
        return await new Promise<ProcessResult>((resolve, reject) => {
          this.pending = { id, resolve, reject };
          abort = () => {
            if (host.connected) host.send({ type: 'abort' }, () => {});
            escalation ??= setTimeout(() => { if (host.pid) try { process.kill(-host.pid, 'SIGKILL'); } catch { /* exited */ } }, 1500);
          };
          signal?.addEventListener('abort', abort, { once: true });
          if (signal?.aborted) abort(); else host.send({ type: 'run', session: true, requestId: id, command, args, cwd }, error => { if (error) { reject(error); abort?.(); } });
        });
      } finally { clearTimeout(timeout); if (escalation) clearTimeout(escalation); if (abort) signal?.removeEventListener('abort', abort); this.pending = undefined; }
    });
    this.tail = request; return request;
  }
  async close(): Promise<void> {
    await this.tail.catch(() => {}); this.closed = true;
    const host = this.host; if (!host) return;
    if (host.connected) host.send({ type: 'finish' }, () => {});
    const force = setTimeout(() => { if (host.pid) try { process.kill(-host.pid, 'SIGKILL'); } catch { /* exited */ } }, 1500);
    try {
      await this.exited;
      if (host.pid) while (liveProcessGroup(host.pid).length) { try { process.kill(-host.pid, 'SIGKILL'); } catch { /* exited */ } await delay(20); }
    } finally { clearTimeout(force); }
  }
}
