import { writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
/** Executable fixture exercising the installed SDK's actual spawn/NDJSON/abort implementation. */
export async function fakeCodex(root: string): Promise<string> {
  const path = join(root, 'fake-codex.cjs');
  await writeFile(path, `#!${process.execPath}
const fs = require('node:fs');
const {spawn} = require('node:child_process');
const emit = value => console.log(JSON.stringify(value));
process.stdin.resume();
process.stdin.on('end', () => {
  emit({type:'thread.started',thread_id:'fixture-thread'});
  emit({type:'turn.started'});
  const mode = process.env.CTX_SDK_FIXTURE;
  if (mode === 'auth' || mode === 'rate') { emit({type:'turn.failed',error:{message: mode === 'auth' ? '401 authentication required' : '429 rate limit'}}); return; }
  if (mode === 'hang') {
    fs.writeFileSync('recovery.txt','recoverable fixture edit\\n');
    process.on('SIGTERM', () => {});
    const child = spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:'ignore'});
    emit({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({descendant:child.pid})}});
    setInterval(()=>{},1000); return;
  }
  fs.writeFileSync('result.txt','fixture change\\n');
  emit({type:'item.started',item:{id:'cmd-1',type:'command_execution',command:'fixture',status:'in_progress'}});
  emit({type:'item.completed',item:{id:'cmd-1',type:'command_execution',command:'fixture',aggregated_output:'fixture output',exit_code:0,status:'completed'}});
  emit({type:'fixture.future',diagnostic:'preserve me'});
  emit({type:'item.completed',item:{id:'msg-1',type:'agent_message',text:'Fixture change complete'}});
  if (mode === 'truncated') return;
  if (mode === 'killed') { process.kill(process.pid,'SIGKILL'); return; }
  emit({type:'turn.completed',usage:{input_tokens:12,cached_input_tokens:0,cache_write_input_tokens:0,output_tokens:3,reasoning_output_tokens:0}});
});
`);
  await chmod(path, 0o700); return path;
}
