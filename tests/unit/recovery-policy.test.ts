import {test} from 'node:test';
import assert from 'node:assert/strict';
import {classifyFailure,recoveryDecision,recoveryPolicy,retryDelay} from '../../packages/shared/src/recovery-policy.js';
test('structured taxonomy wins over logs; unknown failures never invite speculative repair',()=>{
 for(const [code,kind] of Object.entries({TEST_FAILED:'verification',SECURITY_FAILED:'security',APPROVAL_REQUIRED:'approval',AUTH_REQUIRED:'auth',RATE_LIMIT:'capacity',ETIMEDOUT:'network',PROCESS_CRASH:'crash',ENOENT:'missing_file',INSTALL_FAILED:'install',ENVIRONMENT_UNAVAILABLE:'environment',BUDGET_EXHAUSTED:'budget'})) assert.equal(classifyFailure(code,'ENOENT').kind,kind);
 assert.equal(classifyFailure('OTHER','ETIMEDOUT').kind,'unknown'); assert.equal(classifyFailure(undefined,'ETIMEDOUT').source,'heuristic');
});
test('attempt, duplicate, elapsed, token and unknown-cost budgets fail closed; jitter is bounded',()=>{
 const policy=recoveryPolicy({maxCostUsd:1}); const sample={kind:'verification' as const,repairs:0,sameClass:0,identical:1,elapsedMs:0,tokens:2,costUsd:0};
 assert.equal(recoveryDecision(policy,sample),undefined);
 for(const change of [{repairs:2},{sameClass:2},{identical:2},{elapsedMs:3600000},{tokens:undefined},{tokens:100000},{costUsd:undefined},{costUsd:1},{kind:'approval' as const},{kind:'security' as const}]) assert.ok(recoveryDecision(policy,{...sample,...change}));
 assert.equal(retryDelay(policy,1,0),500);assert.equal(retryDelay(policy,2,1),2000);assert.equal(retryDelay(policy,100,1),60000);
});

test('aggregate elapsed budget prevents verification from starting after expiry',async()=>{
 const {engineeringResultPipeline}=await import('../../packages/core/src/result-pipeline.js');
 const repository={queue:{attempts:()=>[{startedAt:'2000-01-01T00:00:00Z'}]}} as unknown as import('../../packages/persistence/src/task-repository.js').TaskRepository;
 const claim={task:{spec:{id:'expired'}}} as import('../../packages/shared/src/scheduling.js').LeaseClaim;
 await assert.rejects(engineeringResultPipeline(repository,{}, {maxElapsedMs:1000})(claim,{kind:'success'},{actorId:'owner',source:'local',requestId:'test'},new AbortController().signal),/Aggregate recovery time budget/);
});
