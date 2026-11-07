import { createServer, createConnection, type Socket } from 'node:net';
import { chmod, lstat, readFile, open, unlink } from 'node:fs/promises';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { ordinaryDirectory } from '../../persistence/src/artifact-files.js';
import type { TaskRepository } from '../../persistence/src/task-repository.js';
import type { DurableScheduler } from './durable-scheduler.js';
import { CtxError } from '../../shared/src/errors.js';
import { record, keys, text, integer } from '../../shared/src/validation.js';
import type { TaskSubmission } from '../../shared/src/repository.js';
export const sentinelPaths = (directory: string) => ({ directory:join(directory,'sentinel'), socket:join(directory,'sentinel','control.sock'), token:join(directory,'sentinel','token'), lock:join(directory,'sentinel','daemon.lock'), log:join(directory,'sentinel','daemon.log') });
export async function prepareSentinel(directory:string):Promise<ReturnType<typeof sentinelPaths>> {
 const paths=sentinelPaths(directory);await ordinaryDirectory(paths.directory,true);const info=await lstat(paths.directory);
 if(info.uid!==process.getuid?.() || (info.mode&0o077)!==0) throw new CtxError('UNAUTHORIZED','Sentinel directory must be private and owned by this user');
 try{const file=await open(paths.token,'wx',0o600);try{await file.writeFile(randomBytes(32).toString('hex'));await file.sync();}finally{await file.close();}}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
 await sentinelToken(directory);return paths;
}
export async function sentinelToken(directory:string):Promise<string>{
 const paths=sentinelPaths(directory);for(const path of [paths.directory,paths.token]){const info=await lstat(path);if(info.isSymbolicLink()||info.uid!==process.getuid?.()||(info.mode&0o077)!==0||path===paths.token&&(!info.isFile()||info.nlink!==1))throw new CtxError('UNAUTHORIZED','Unsafe Sentinel credential path');}
 const value=await readFile(paths.token,'utf8');if(!/^[a-f0-9]{64}$/.test(value))throw new CtxError('CONFLICT','Invalid Sentinel credential');return value;
}
export async function sentinelRequest(directory:string, command:string, input:unknown={}, timeoutMs=5000):Promise<any>{
 const token=await sentinelToken(directory);return new Promise((resolve,reject)=>{
 const socket=createConnection(sentinelPaths(directory).socket);let data='';socket.setTimeout(timeoutMs,()=>socket.destroy(new Error('Sentinel request timed out')));
 socket.once('connect',()=>socket.end(JSON.stringify({version:1,token,command,input})+'\n'));
 socket.on('data',chunk=>{data+=chunk;if(data.length>10000000)socket.destroy(new Error('Sentinel response too large'));});socket.once('error',reject);
 socket.once('end',()=>{try{const response=JSON.parse(data);if(!response.ok)throw new CtxError(response.error.code,response.error.message);resolve(response.value);}catch(error){reject(error);}});
 });
}
export async function startSentinel(repo:TaskRepository,scheduler:DurableScheduler,options:{locked?:boolean;pollMs?:number}={}){
 const paths=await prepareSentinel(repo.dataDirectory);const token=await sentinelToken(repo.dataDirectory);
 if(options.locked){try{const info=await lstat(paths.socket);if(!info.isSocket()||info.uid!==process.getuid?.())throw new CtxError('CONFLICT','Refusing to remove an unowned socket path');await unlink(paths.socket);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
 let stopping=false;let timer:NodeJS.Timeout|undefined;let pump:Promise<void>|undefined;let again=false;let lastError:string|undefined;let closing:Promise<void>|undefined;
 const sockets=new Set<Socket>();const actor={actorId:`local:${process.getuid?.()}`,source:'cli' as const,requestId:randomUUID()};
 const status=()=>{const queue=repo.queue.status();return {pid:process.pid,state:scheduler.activeCount||queue.running?'EXECUTING':queue.configuration.paused?'PAUSED':queue.nextRunAt?'WAITING_CAPACITY':'SENTINEL_IDLE',activeWorkers:scheduler.activeCount,queue,lastError:lastError??scheduler.lastError,stopping};};
 function wake(){if(stopping)return;if(timer)clearTimeout(timer);if(pump){again=true;return;}pump=(async()=>{do{again=false;try{await scheduler.runUntilIdle({timeoutMs:60000});}catch(error){if(!(error instanceof CtxError&&error.code==='TIMEOUT')){lastError=error instanceof CtxError?error.message:'Scheduler reconciliation failed';break;}}}while(!stopping&&(again||scheduler.activeCount));})().finally(()=>{pump=undefined;if(stopping)return;const next=repo.queue.status().nextRunAt;const delay=next?Math.max(25,Date.parse(next)-Date.now()):options.pollMs??30000;timer=setTimeout(wake,Math.min(options.pollMs??30000,delay));});}
 const server=createServer({allowHalfOpen:true},socket=>{
  if(stopping||sockets.size>=32){socket.destroy();return;}sockets.add(socket);socket.on('error',()=>{});socket.once('close',()=>sockets.delete(socket));socket.setTimeout(5000,()=>socket.destroy());let data='';let handled=false;
  socket.on('data',chunk=>{if(handled)return;data+=chunk;if(Buffer.byteLength(data)>1000000){socket.destroy();return;}if(!data.includes('\n'))return;handled=true;
   void(async()=>{try{
    const request=record(JSON.parse(data.slice(0,data.indexOf('\n'))),'request');keys(request,['version','token','command','input'],'request');
    if(request.version!==1||typeof request.token!=='string'||request.token.length!==token.length||!timingSafeEqual(Buffer.from(request.token),Buffer.from(token)))throw new CtxError('UNAUTHORIZED','Invalid local IPC credentials');
    const command=text(request.command,'command',30);const input=record(request.input??{},'input');const context={...actor,requestId:randomUUID()};let value:unknown;
    switch(command){
     case 'status': value=status();break;
     case 'query':value={tasks:repo.listTasks().slice(0,100),outbox:repo.pendingNotifications(100)};break;
     case 'submit': keys(input,['spec','deduplicationKey'],'input');value=repo.submitTask({...input,destination:{kind:'local',address:actor.actorId}} as unknown as TaskSubmission,context);wake();break;
     case 'pause':case 'resume':case 'cancel':case 'retry':keys(input,['taskId','revision','reason'],'input');value=repo.queue.controlTask(text(input.taskId,'taskId',200),command,integer(input.revision,1,Number.MAX_SAFE_INTEGER,'revision'),context,text(input.reason??'Local owner command','reason'));wake();break;
     case 'stop':value={stopping:true};setImmediate(()=>{void close();});break;
     default:throw new CtxError('INVALID_INPUT','Unsupported Sentinel command');
    }socket.end(JSON.stringify({ok:true,value})+'\n');
   }catch(error){socket.end(JSON.stringify({ok:false,error:error instanceof CtxError?error.toJSON():{code:'INVALID_INPUT',message:'Invalid local command'}})+'\n');}})();
  });
 });
 async function close():Promise<void>{if(closing)return closing;closing=(async()=>{stopping=true;if(timer)clearTimeout(timer);server.close();for(const socket of sockets)socket.end();await scheduler.shutdown();await pump;for(const socket of sockets)socket.destroy();})();return closing;}
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(paths.socket,resolve);});await chmod(paths.socket,0o600);wake();
 return {status,wake,close,closed:new Promise<void>(resolve=>server.once('close',resolve))};
}
