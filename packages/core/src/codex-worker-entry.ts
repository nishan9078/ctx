/** Private IPC host for the public SDK. Each event is acknowledged after durable persistence. */
import { Codex } from '@openai/codex-sdk';
import { readFileSync } from 'node:fs';
import { CodexSdkAdapter } from '../../agents/src/codex-sdk.adapter.js';
const abort = new AbortController();
let acknowledge: (() => void) | undefined;
let started = false;
let finished = false;
let orphanTimer: NodeJS.Timeout | undefined;
function stopOrphan() {
  if (finished) return;
  abort.abort(); acknowledge?.(); process.exitCode = 1;
  if (orphanTimer) return;
  orphanTimer = setTimeout(() => {
    // Only the dedicated, detached IPC host may signal its own process group.
    const stat = readFileSync(`/proc/${process.pid}/stat`, 'utf8');
    if (Number(stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/)[2]) === process.pid) process.kill(-process.pid, 'SIGKILL');
  }, 1000);
}
process.on('disconnect', stopOrphan);
process.on('SIGTERM', stopOrphan);
process.on('message', async (message: unknown) => {
  if (!message || typeof message !== 'object') return;
  const input = message as Record<string, unknown>;
  if (input.type === 'ack') { acknowledge?.(); acknowledge = undefined; return; }
  if (input.type === 'abort') { abort.abort(); acknowledge?.(); return; }
  if (input.type !== 'run' || started) return;
  started = true;
  try {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => key !== 'NODE_TEST_CONTEXT' && value !== undefined)) as Record<string, string>;
    const client = new Codex({ env, codexPathOverride: typeof input.codexPathOverride === 'string' ? input.codexPathOverride : undefined });
    const adapter = new CodexSdkAdapter(client, typeof input.model === 'string' ? input.model : undefined);
    const result = await adapter.execute({ prompt: String(input.prompt), workspacePath: String(input.workspacePath), sessionId: typeof input.sessionId === 'string' ? input.sessionId : undefined, signal: abort.signal,
      async onEvent(event) {
        if (abort.signal.aborted) throw new Error('Interrupted');
        await new Promise<void>((resolve, reject) => {
          acknowledge = resolve;
          process.send?.({ type: 'event', event: event.data }, error => { if (error) reject(error); });
        });
      },
    });
    if (orphanTimer) return; // Keep the host alive until the owned group is killed.
    process.send?.({ type: 'result', outcome: result.outcome, summary: result.summary }, () => {
      finished = true; if (orphanTimer) clearTimeout(orphanTimer);
      process.exitCode = result.outcome === 'completed' ? 0 : 1;
      process.disconnect();
    });
  } catch {
    if (orphanTimer) return;
    finished = true; if (orphanTimer) clearTimeout(orphanTimer);
    process.exitCode = 1; if (process.connected) process.disconnect();
  }
});
