/** Internal detached host. Owns a local command and kills its group if its parent disappears. */
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
let command: ChildProcess | undefined; let stopping = false; let finished = false;
let killTimer: NodeJS.Timeout | undefined;
function terminate() {
  if (finished || stopping) return; stopping = true;
  command?.kill('SIGTERM');
  killTimer = setTimeout(() => {
    const stat = readFileSync(`/proc/${process.pid}/stat`, 'utf8');
    if (Number(stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/)[2]) === process.pid) process.kill(-process.pid, 'SIGKILL');
    else process.exit(1);
  }, 1000);
}
process.on('disconnect', terminate); process.on('SIGTERM', terminate);
process.on('message', message => {
  const frame = message as { type?: string; command?: string; args?: string[]; cwd?: string; session?: boolean; requestId?: number };
  if (frame.type === 'finish' && !command) { finished = true; process.disconnect(); return; }
  if (frame.type === 'abort') { terminate(); return; }
  if (frame.type !== 'run' || command || stopping) return;
  const child = spawn(frame.command!, frame.args!, { cwd: frame.cwd, stdio: frame.session ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'], env: process.env });
  command = child;
  if (frame.session) {
    let output = ''; let truncated = false; let failed = false;
    const collect = (bytes: Buffer) => { truncated ||= output.length + bytes.length > 1000000; output = (output + bytes.toString()).slice(-1000000); };
    child.stdout?.on('data', collect); child.stderr?.on('data', collect);
    child.once('error', () => { failed = true; });
    child.once('close', code => { if (stopping) return; command = undefined; process.send?.({ type: 'result', requestId: frame.requestId, code: failed ? null : code, output, truncated }); });
  } else {
    child.on('error', () => { if (!stopping) { finished = true; process.exitCode = 1; process.send?.({ type: 'result', code: null }, () => process.disconnect()); } });
    child.on('exit', code => {
      if (stopping || finished) return;
      finished = true; if (killTimer) clearTimeout(killTimer); process.exitCode = code ?? 1;
      process.send?.({ type: 'result', code }, () => process.disconnect());
    });
  }
});
if (!process.connected) terminate();
