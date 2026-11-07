import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,readFile,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createConnection} from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
import {TaskRepository} from '../../packages/persistence/src/task-repository.js';
import {DurableScheduler} from '../../packages/core/src/durable-scheduler.js';
import {FixtureWorker} from '../../packages/core/src/fixture-worker.js';
import {startSentinel,sentinelRequest,sentinelPaths} from '../../packages/core/src/sentinel.js';
import {queueSubmission,queueActor as actor} from '../fixtures/queue.js';
async function until(check:()=>boolean|Promise<boolean>){for(let i=0;i<300;i++){if(await check())return;await delay(20);}assert.fail('Sentinel condition did not settle');}
async function fixture(){const root=await mkdtemp(join(tmpdir(),'ctx-sentinel-'));const project=join(root,'project');await mkdir(project);const filename=join(root,'data/state.sqlite');const repo=await TaskRepository.open(filename);await repo.registerProject({id:'fixture',repositoryPath:project,policyId:'fixture-only',verificationProfile:'fixture-v1'},actor,'Disposable daemon fixture');return {root,repo,filename};}
function submission(id:string){const {spec,deduplicationKey}=queueSubmission(id);return {spec,deduplicationKey};}
test('idle authenticated ingress starts work independently of clients and returns to idle without workers',async()=>{
 const f=await fixture();const scheduler=new DurableScheduler(f.repo,new FixtureWorker(f.repo.dataDirectory,{job:[{outcome:'success',sleepMs:200}]}));const daemon=await startSentinel(f.repo,scheduler,{pollMs:100});
 try{
  assert.equal(daemon.status().state,'SENTINEL_IDLE');const paths=sentinelPaths(f.repo.dataDirectory);assert.equal((await stat(paths.socket)).mode&0o077,0);assert.equal((await stat(paths.token)).mode&0o077,0);
  const bad=await new Promise<string>((resolve,reject)=>{let data='';const socket=createConnection(paths.socket);socket.on('error',reject);socket.on('connect',()=>socket.end(JSON.stringify({version:1,token:'0'.repeat(64),command:'submit',input:submission('bad')})+'\n'));socket.on('data',chunk=>data+=chunk);socket.on('end',()=>resolve(data));});assert.equal(JSON.parse(bad).error.code,'UNAUTHORIZED');assert.equal(f.repo.listTasks().length,0);
  await sentinelRequest(f.repo.dataDirectory,'submit',submission('job'));await until(()=>daemon.status().state==='EXECUTING');
  // The submitting client's socket is already gone; execution must continue.
  await until(()=>f.repo.getTask('job').state==='completed');await until(()=>daemon.status().state==='SENTINEL_IDLE');assert.equal(scheduler.activeCount,0);assert.equal(f.repo.queue.attempts('job').length,1);
  const duplicate=await sentinelRequest(f.repo.dataDirectory,'submit',submission('job'));assert.equal(duplicate.duplicate,true);assert.ok((await sentinelRequest(f.repo.dataDirectory,'query')).outbox.length>=2);
 }finally{await daemon.close();f.repo.close();await rm(f.root,{recursive:true,force:true});}
});
test('restart rehydrates capacity deadlines and outbox; idle service never starts a harness early',async()=>{
 const f=await fixture();const scripts={timer:[{outcome:'capacity' as const,retryDelayMs:1500},{outcome:'success' as const}]};let repo=f.repo;
 let daemon=await startSentinel(repo,new DurableScheduler(repo,new FixtureWorker(repo.dataDirectory,scripts)),{pollMs:100});
 try{
  await sentinelRequest(repo.dataDirectory,'submit',submission('timer'));await until(()=>repo.getTask('timer').state==='waiting_capacity');const deadline=repo.getTask('timer').nextRunAt;const notices=repo.pendingNotifications().map(n=>n.id);assert.equal(daemon.status().state,'WAITING_CAPACITY');
  await daemon.close();repo.close();repo=await TaskRepository.open(f.filename);assert.equal(repo.getTask('timer').nextRunAt,deadline);assert.deepEqual(repo.pendingNotifications().map(n=>n.id),notices);
  daemon=await startSentinel(repo,new DurableScheduler(repo,new FixtureWorker(repo.dataDirectory,scripts)),{pollMs:100});assert.equal(repo.queue.attempts('timer').length,1);await until(()=>repo.getTask('timer').state==='completed');assert.equal(repo.queue.attempts('timer').length,2);
 }finally{await daemon.close();repo.close();await rm(f.root,{recursive:true,force:true});}
});
test('shutdown quiesces active work and preserves a resumable durable disposition',async()=>{
 const f=await fixture();const scheduler=new DurableScheduler(f.repo,new FixtureWorker(f.repo.dataDirectory,{slow:[{outcome:'success',sleepMs:10000}]}));const daemon=await startSentinel(f.repo,scheduler);
 try{await sentinelRequest(f.repo.dataDirectory,'submit',submission('slow'));await until(()=>scheduler.activeCount===1);await daemon.close();assert.equal(scheduler.activeCount,0);assert.equal(f.repo.queue.attempts('slow')[0].state,'interrupted');assert.notEqual(f.repo.getTask('slow').state,'completed');}finally{await daemon.close();f.repo.close();await rm(f.root,{recursive:true,force:true});}
});

test('detached CLI daemon survives client exit and SIGKILL restart with a single kernel-lock owner',async()=>{
 const {runOwnedCommand}=await import('../../packages/environment/src/owned-command.js');const {resolve}=await import('node:path');
 const f=await fixture();f.repo.queue.pauseAll(true,actor);f.repo.submitTask(queueSubmission('retained'),actor);const outbox=f.repo.pendingNotifications().map(n=>n.id);
 const cli=(command:string)=>runOwnedCommand(process.execPath,[resolve('dist/apps/cli/src/index.js'),'daemon',command,'--database',f.filename],process.cwd(),{timeoutMs:15000});
 let pid:number|undefined;
 try{
  const started=await cli('start');assert.equal(started.code,0,started.output);pid=JSON.parse(started.stdout!).pid;
  assert.equal((await sentinelRequest(f.repo.dataDirectory,'status')).state,'PAUSED');
  const contender=await runOwnedCommand('/usr/bin/flock',['--nonblock',sentinelPaths(f.repo.dataDirectory).lock,process.execPath,'-e','console.log(\"UNEXPECTED_SECOND_OWNER\")'],process.cwd(),{timeoutMs:5000});assert.notEqual(contender.code,0);assert.doesNotMatch(contender.output,/UNEXPECTED_SECOND_OWNER/);
  const duplicate=await cli('start');assert.equal(duplicate.code,0,duplicate.output);assert.equal(JSON.parse(duplicate.stdout!).pid,pid);
  process.kill(pid!,'SIGKILL');await until(async()=>{try{await sentinelRequest(f.repo.dataDirectory,'status');return false;}catch{return true;}});
  const restarted=await cli('start');assert.equal(restarted.code,0,restarted.output);const next=JSON.parse(restarted.stdout!);assert.notEqual(next.pid,pid);pid=next.pid;
  const result=await sentinelRequest(f.repo.dataDirectory,'query');assert.equal(result.tasks[0].spec.id,'retained');assert.deepEqual(result.outbox.map((n:{id:string})=>n.id),outbox);
  assert.equal((await cli('stop')).code,0);await until(async()=>{try{await sentinelRequest(f.repo.dataDirectory,'status');return false;}catch{return true;}});pid=undefined;
 }finally{if(pid){try{process.kill(pid,'SIGTERM');}catch{}}f.repo.close();await rm(f.root,{recursive:true,force:true});}
});


test('a held durable lease remains observable even before this daemon has a local worker',async()=>{
 const f=await fixture();f.repo.submitTask(queueSubmission('held'),actor);f.repo.queue.refresh(actor);const claim=f.repo.queue.claim({ownerId:'other-controller',workerKind:'fixture',leaseMs:10000},actor)!;
 const observer={activeCount:0,lastError:undefined,async runUntilIdle(){return f.repo.queue.status();},async shutdown(){}} as unknown as DurableScheduler;
 const daemon=await startSentinel(f.repo,observer);
 try{assert.equal(daemon.status().state,'EXECUTING');assert.equal(daemon.status().activeWorkers,0);}finally{await daemon.close();f.repo.queue.stopped(claim,actor,'Unstarted test owner stopped');f.repo.close();await rm(f.root,{recursive:true,force:true});}
});
