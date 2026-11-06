import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readdirSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import type { CodexExecutor, CodexRunInput, CodexRunResult } from '../../agents/src/codex-execution-port.js';
import { processIdentity } from '../../persistence/src/process-identity.js';
import { CtxError } from '../../shared/src/errors.js';

/** Enumerate live members, including descendants whose group leader already exited. */
export function liveProcessGroup(pgid: number): number[] {
  const members: number[] = [];
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8'); const fields = stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/);
      if (Number(fields[2]) === pgid && fields[0] !== 'Z' && fields[0] !== 'X') members.push(Number(name));
    } catch (error) { if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
  }
  return members;
}
export class SupervisedCodexExecutor implements CodexExecutor {
  constructor(private readonly options: { entry?: string; codexPathOverride?: string; graceMs?: number; env?: NodeJS.ProcessEnv } = {}) {}
  async run(input: CodexRunInput): Promise<CodexRunResult> {
    if (input.signal.aborted) return { exitCode: null, exitSignal: null, stderrTail: '', stderrTruncated: false, aborted: true, spawned: false };
    if (process.platform !== 'linux') throw new CtxError('ENVIRONMENT_UNAVAILABLE', 'Codex process containment is currently verified on Linux only');
    const env = { ...(this.options.env ?? process.env) }; delete env.NODE_TEST_CONTEXT;
    const child = fork(this.options.entry ?? fileURLToPath(new URL('./codex-worker-entry.js', import.meta.url)), [], { cwd: input.workspacePath, env, execArgv: [], detached: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    const pgid = child.pid;
    let stderrTail = ''; let stderrTruncated = false; let failure: unknown; let chain = Promise.resolve(); let killTimer: NodeJS.Timeout | undefined;
    let stopping = false; let resultSeen = false;
    const closed = new Promise<{ code: number | null; signal: string | null }>(resolve => {
      child.once('error', error => { failure = error; });
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    const kill = (signal: NodeJS.Signals) => { if (pgid) { try { process.kill(-pgid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') failure ??= error; } } };
    const stop = () => {
      if (stopping) return; stopping = true;
      if (child.connected) child.send({ type: 'abort' }, () => {});
      killTimer = setTimeout(() => kill('SIGTERM'), this.options.graceMs ?? 1000);
    };
    child.stderr?.on('data', (bytes: Buffer) => { stderrTruncated ||= stderrTail.length + bytes.length > 16384; stderrTail = (stderrTail + bytes.toString()).slice(-16384); });
    child.on('message', (message: unknown) => {
      chain = chain.then(async () => {
        if (!message || typeof message !== 'object') throw new Error('Malformed worker IPC');
        const frame = message as Record<string, unknown>;
        if (frame.type === 'event') {
          if (resultSeen || Buffer.byteLength(JSON.stringify(frame.event) ?? '') > 8 * 1024 * 1024) throw new Error('Invalid or oversized SDK event');
          await input.onRawEvent(frame.event);
          if (child.connected) child.send({ type: 'ack' }, () => {});
        } else if (frame.type === 'result') {
          if (resultSeen) throw new Error('Duplicate worker result'); resultSeen = true;
          if (frame.outcome !== 'completed' && typeof frame.summary === 'string') stderrTail = frame.summary.slice(-16384);
        } else throw new Error('Unknown worker IPC');
      }).catch(error => { failure ??= error; stop(); });
    });
    input.signal.addEventListener('abort', stop, { once: true });
    const startup = setTimeout(() => { failure ??= new Error('Codex worker startup timed out'); stop(); }, 10000);
    // Keep termination escalation alive even if the group leader exits first.
    const escalation = setInterval(() => { if (stopping) kill('SIGKILL'); }, (this.options.graceMs ?? 1000) + 1000);
    try {
      if (!pgid) { await closed; throw failure ?? new CtxError('HARNESS_UNAVAILABLE', 'Unable to spawn Codex worker'); }
      const identity = processIdentity(pgid);
      if (identity === 'unknown') throw new CtxError('ENVIRONMENT_UNAVAILABLE', 'Cannot establish Codex process identity');
      await input.onProcess?.({ pid: pgid, pgid, host: hostname(), identity, startedAt: new Date().toISOString() });
      clearTimeout(startup);
      if (input.signal.aborted) stop();
      else child.send({ type: 'run', prompt: input.prompt, workspacePath: input.workspacePath, sessionId: input.sessionId, model: input.model, codexPathOverride: this.options.codexPathOverride }, error => { if (error) { failure ??= error; stop(); } });
      const exit = await closed; await chain;
      // A normally exited leader can still leave command descendants. They are ours to reap too.
      if (liveProcessGroup(pgid).length) {
        kill('SIGTERM');
        const until = Date.now() + (this.options.graceMs ?? 1000);
        while (liveProcessGroup(pgid).length && Date.now() < until) await delay(20);
        if (liveProcessGroup(pgid).length) kill('SIGKILL');
        while (liveProcessGroup(pgid).length) await delay(20);
      }
      if (failure) throw failure;
      return { exitCode: exit.code, exitSignal: exit.signal, stderrTail, stderrTruncated, aborted: input.signal.aborted, spawned: true };
    } catch (error) {
      stop(); kill('SIGKILL'); await closed;
      if (pgid) while (liveProcessGroup(pgid).length) { kill('SIGKILL'); await delay(20); }
      throw error;
    } finally {
      clearTimeout(startup); clearInterval(escalation); if (killTimer) clearTimeout(killTimer);
      input.signal.removeEventListener('abort', stop);
    }
  }
}
