import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { open, access, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { prepareSentinel, sentinelRequest } from '../../../packages/core/src/sentinel.js';
export async function daemonCommand(operation:string, database:string, argument?:string, options:{revision?:string;reason?:string}={}):Promise<number>{
 const filename=resolve(database);const directory=dirname(filename);await access(filename);
 if(operation==='start'){
  try{console.log(JSON.stringify(await sentinelRequest(directory,'status')));return 0;}catch(error){if(!['ENOENT','ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code??''))throw error;}
  const paths=await prepareSentinel(directory);
  const lock=await open(paths.lock,constants.O_CREAT|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);await lock.close();
  const log=await open(paths.log,constants.O_CREAT|constants.O_APPEND|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
  const child=spawn('/usr/bin/flock',['--exclusive','--nonblock','--no-fork',paths.lock,process.execPath,fileURLToPath(new URL('../../daemon/src/index.js',import.meta.url)),'--locked',filename],{detached:true,stdio:['ignore',log.fd,log.fd],env:process.env});
  let failure:Error|undefined;child.once('error',error=>{failure=error;});child.unref();await log.close();
  for(let i=0;i<100;i++){if(failure)throw failure;try{console.log(JSON.stringify(await sentinelRequest(directory,'status')));return 0;}catch(error){if(!['ENOENT','ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code??''))throw error;}if(child.exitCode!==null)throw new Error('Daemon startup failed; inspect private sentinel/daemon.log');await delay(100);}
  throw new Error('Daemon readiness timeout; inspect private sentinel/daemon.log');
 }
 const input=operation==='submit'?JSON.parse(await readFile(argument??'', 'utf8')):['pause','resume','cancel','retry'].includes(operation)?{taskId:argument,revision:Number(options.revision),reason:options.reason??'Local owner command'}:{};
 if(!['status','stop','query','submit','pause','resume','cancel','retry'].includes(operation))throw new Error('Use daemon start|stop|status|query|submit|pause|resume|cancel|retry');
 console.log(JSON.stringify(await sentinelRequest(directory,operation,input),null,2));return 0;
}
