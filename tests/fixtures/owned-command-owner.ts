import { runOwnedCommand } from '../../packages/environment/src/owned-command.js';
import { OwnedCommandSession } from '../../packages/environment/src/owned-command-session.js';
import { liveProcessGroup } from '../../packages/environment/src/process-group.js';
import { setTimeout as delay } from 'node:timers/promises';
const descendant = 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)';
const script = `const {spawn}=require("node:child_process");process.on("SIGTERM",()=>{});spawn(process.execPath,["-e",${JSON.stringify(descendant)}],{stdio:"inherit"});console.log("ready");setInterval(()=>{},1000)`;
if (process.argv[2] === 'session') {
  let pgid = 0;
  const session = new OwnedCommandSession({ onProcess(id) { pgid = id; process.send?.({ type: 'owned', pgid }); } });
  const run = session.run(process.execPath, ['-e', script], process.cwd()); void run.catch(() => {});
  const until = Date.now() + 5000;
  while ((!pgid || liveProcessGroup(pgid).length < 3) && Date.now() < until) await delay(25);
  process.send?.({ type: 'running' }); await run; await session.close();
} else {
  await runOwnedCommand(process.execPath, ['-e', script], process.cwd(), {
    onProcess(pgid) { process.send?.({ type: 'owned', pgid }); },
    onOutput(output) { if (output.trim() === 'ready') process.send?.({ type: 'running' }); },
  });
}
