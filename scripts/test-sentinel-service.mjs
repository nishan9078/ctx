import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { TaskRepository } from '../dist/packages/persistence/src/task-repository.js';
import { prepareSentinel, sentinelRequest } from '../dist/packages/core/src/sentinel.js';
const root=await mkdtemp(join(tmpdir(),'ctx-systemd-'));const filename=join(root,'state.sqlite');const unit=`ctx-acceptance-${randomUUID()}`;let started=false;
const repository=await TaskRepository.open(filename);repository.queue.pauseAll(true,{actorId:'service-test',source:'local',requestId:unit});repository.close();const paths=await prepareSentinel(root);
const request=()=>sentinelRequest(root,'status');
async function ready(){for(let i=0;i<100;i++){try{return await request();}catch{await delay(50);}}throw new Error('Service readiness timeout');}
try{
 execFileSync('systemd-run',['--user',`--unit=${unit}`,'--property=Type=simple','--property=Restart=on-failure','--property=KillMode=control-group','--property=UMask=0077','/usr/bin/flock','--exclusive','--nonblock','--no-fork',paths.lock,process.execPath,resolve('dist/apps/daemon/src/index.js'),'--locked',filename],{stdio:'pipe'});started=true;
 const before=await ready();assert.equal(before.state,'PAUSED');assert.equal(before.activeWorkers,0);
 execFileSync('systemctl',['--user','restart',unit],{stdio:'pipe'});const after=await ready();assert.notEqual(after.pid,before.pid);assert.equal(after.state,'PAUSED');assert.equal(after.activeWorkers,0);
 console.log(JSON.stringify({serviceRestart:'passed',persistentPause:'passed',beforePid:before.pid,afterPid:after.pid,activeInferenceWorkers:0,logout:'not performed; no lingering change',unit},null,2));
}finally{if(started)execFileSync('systemctl',['--user','stop',unit],{stdio:'pipe'});await rm(root,{recursive:true,force:true});}
