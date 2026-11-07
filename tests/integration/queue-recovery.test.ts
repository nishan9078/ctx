import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { engineeringFixture, controlledEngineeringWorker, readyProbe } from '../fixtures/engineering.js';
import { createCodexQueueScheduler } from '../../packages/core/src/codex-queue-worker.js';
for (const repairable of [true,false]) test(`bounded retained-worktree recovery: repairable=${repairable}`, async () => {
 const f=await engineeringFixture(); let count=0; let first='';
 const scheduler=createCodexQueueScheduler(f.repository,{probe:readyProbe,recovery:{baseDelayMs:10,maxDelayMs:10},executor:controlledEngineeringWorker(async workspace=>{
   count++; if(count===1) first=workspace; else assert.equal(workspace,first);
   if(count===1 || !repairable) await writeFile(join(workspace,'src/app.ts'),'export function add(a:number,b:number):number{return a-b;}');
 })});
 try {const status=await scheduler.runUntilIdle({waitForDeadlines:true,timeoutMs:60000}); assert.equal(count,2,f.repository.getTask('task').reason); assert.equal(repairable?status.completed:status.blocked,1,f.repository.getTask('task').reason); assert.match(await readFile(join(f.project,'src/app.ts'),'utf8'),/return 0/); assert.equal(f.repository.queue.attempts('task').length,2);}
 finally{await scheduler.shutdown();await f.cleanup();}
});

test('checkpoint reopens with preserved diff; changed worktree is rejected and denied approval prevents scheduling',async()=>{
 const {readRecoveryCheckpoint}=await import('../../packages/core/src/recovery-checkpoint.js');
 const {recoveryPolicy}=await import('../../packages/shared/src/recovery-policy.js');
 const {TaskRepository}=await import('../../packages/persistence/src/task-repository.js');
 const {DatabaseSync}=await import('node:sqlite');
 const {repositoryActor:actor}=await import('../fixtures/repository.js');
 const f=await engineeringFixture(); const policy=recoveryPolicy({maxRepairs:0});
 const scheduler=createCodexQueueScheduler(f.repository,{probe:readyProbe,recovery:policy,executor:controlledEngineeringWorker(async workspace=>{await writeFile(join(workspace,'src/app.ts'),'export function add(a:number,b:number):number{return a-b;}');})});
 try{
  assert.equal((await scheduler.runUntilIdle({timeoutMs:60000})).blocked,1);const attempt=f.repository.queue.attempts('task')[0];
  const reopened=await TaskRepository.open(f.filename);
  try{const saved=await readRecoveryCheckpoint(reopened,'task',attempt.id,policy);assert.ok(saved);assert.ok(saved.checkpoint.changedFiles.includes('src/app.ts'));assert.match(await readFile(join(saved.checkpoint.worktree,'src/app.ts'),'utf8'),/a-b/);
   await writeFile(join(saved.checkpoint.worktree,'src/app.ts'),'human change');await assert.rejects(readRecoveryCheckpoint(reopened,'task',attempt.id,policy),/differs from checkpoint/);
  }finally{reopened.close();}
  const db=new DatabaseSync(f.filename);try{db.prepare("INSERT INTO ctx_approvals VALUES(?,?,?,?,?,?,?,?,?,?,?)").run('denied','task',f.repository.getTask('task').revision,attempt.id,'external_write','a'.repeat(64),'owner',new Date(Date.now()+60000).toISOString(),'rejected','owner',new Date().toISOString());}finally{db.close();}
  assert.throws(()=>f.repository.queue.controlTask('task','retry',f.repository.getTask('task').revision,actor,'Retry denied action'));
 }finally{await scheduler.shutdown();await f.cleanup();}
});

test('zero-token and unavailable cost accounting stop before invoking the provider',async()=>{
 for(const recovery of [{maxTokens:0},{maxCostUsd:1}]){
  const f=await engineeringFixture();let invoked=0;
  const scheduler=createCodexQueueScheduler(f.repository,{probe:readyProbe,recovery,executor:{async run(){invoked++;throw new Error('Provider must not run');}}});
  try{assert.equal((await scheduler.runUntilIdle({timeoutMs:30000})).blocked,1);assert.equal(invoked,0);}finally{await scheduler.shutdown();await f.cleanup();}
 }
});
