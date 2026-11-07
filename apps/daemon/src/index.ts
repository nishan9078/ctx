#!/usr/bin/env node
import { resolve } from 'node:path';
import { TaskRepository } from '../../../packages/persistence/src/task-repository.js';
import { createCodexQueueScheduler } from '../../../packages/core/src/codex-queue-worker.js';
import { startSentinel } from '../../../packages/core/src/sentinel.js';
if(process.argv[2]!=='--locked'||!process.argv[3])throw new Error('Use ctx daemon start or the documented flock service command');
const repository=await TaskRepository.open(resolve(process.argv[3]));
const scheduler=createCodexQueueScheduler(repository);
try{
 const daemon=await startSentinel(repository,scheduler,{locked:true});
 const shutdown=()=>{void daemon.close().catch(()=>{process.exitCode=1;});};process.once('SIGTERM',shutdown);process.once('SIGINT',shutdown);
 console.log(JSON.stringify({event:'sentinel.ready',pid:process.pid}));
 await daemon.closed;await daemon.close();
}finally{await scheduler.shutdown();repository.close();}
