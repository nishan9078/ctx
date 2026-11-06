import { spawn } from 'node:child_process';
let started = false;
process.on('SIGTERM', () => {});
process.on('message', message => {
  const frame = message as { type?: string };
  if (frame.type !== 'run' || started) return; started = true;
  const mode = process.env.CTX_PROCESS_FIXTURE;
  if (mode === 'abnormal') { process.kill(process.pid, 'SIGKILL'); return; }
  if (mode === 'descendant' || mode === 'cancel') {
    const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], { stdio: 'ignore' });
    process.send?.({ type: 'event', event: { type: 'fixture.descendant', pid: child.pid } });
    if (mode === 'descendant') setTimeout(() => process.exit(0), 100);
    return;
  }
  process.send?.({ type: 'event', event: { type: 'thread.started', thread_id: 'fixture-thread' } });
});
process.on('message', message => {
  if ((message as { type?: string }).type === 'ack' && !['cancel', 'descendant'].includes(process.env.CTX_PROCESS_FIXTURE ?? '')) {
    process.send?.({ type: 'result', outcome: 'completed' }, () => { process.disconnect(); });
  }
});
