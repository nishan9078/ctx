import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskRepository } from '../../packages/persistence/src/task-repository.js';
import { repositoryActor as actor, submissionFixture } from './repository.js';
import type { VerificationProfile, GateReport } from '../../packages/shared/src/verification-profile.js';
import type { CodexExecutor } from '../../packages/agents/src/codex-execution-port.js';
export const readyProbe = async () => ({ sdkVersion: '0.166.0', cliVersion: 'controlled-fixture', cliAvailable: true, auth: 'auth-file' as const, model: 'unknown' as const, provider: 'unknown' as const, probeErrors: [] });
export async function engineeringFixture(adjust?: (profile: VerificationProfile) => void) {
  const root = await mkdtemp(join(tmpdir(), 'ctx-gates-')); const project = join(root, 'project'); await mkdir(join(project, 'src'), { recursive: true }); await mkdir(join(project, 'tests'));
  await writeFile(join(project, 'src/app.ts'), 'export function add(a: number, b: number): number { return 0; }\n');
  await writeFile(join(project, 'tests/app.test.cjs'), 'const {test}=require("node:test");const assert=require("node:assert/strict");test("add",()=>assert.equal(require("../dist/app.js").add(2,3),5));\n');
  await writeFile(join(project, 'package.json'), '{"name":"verification-fixture","private":true,"scripts":{"test":"node --test tests/app.test.cjs"}}');
  await writeFile(join(project, 'lint.cjs'), 'const fs=require("node:fs");if(fs.readFileSync("src/app.ts","utf8").includes("debugger"))process.exit(1);console.log("Configured fixture lint passed");\n');
  await writeFile(join(project, 'build-fail.cjs'), 'console.error("Controlled build failure");process.exit(2);');
  await writeFile(join(project, 'slow.cjs'), 'setInterval(()=>{},1000);');
  const filename = join(root, 'data/state.sqlite'); const repository = await TaskRepository.open(filename);
  await repository.registerProject({ id: 'fixture', repositoryPath: project, policyId: 'safe', verificationProfile: 'node-api' }, actor, 'Owner approved disposable verification project');
  const compiler = resolve('node_modules/typescript/bin/tsc'); const compile = [compiler, '--strict', '--target', 'ES2022', '--module', 'commonjs'];
  const profile: VerificationProfile = { schemaVersion: 1, id: 'node-api', purpose: 'code', backend: 'host', generatedPaths: ['dist/**'], protectedPaths: ['lint.cjs','build-fail.cjs','slow.cjs'], steps: [
    { id: 'scope', kind: 'scope', required: true, waivable: false, timeoutMs: 10000, integration: 'live' },
    { id: 'integrity', kind: 'test_integrity', required: true, waivable: false, timeoutMs: 10000, integration: 'live' },
    { id: 'secrets', kind: 'secrets', required: true, waivable: false, timeoutMs: 10000, integration: 'live' },
    { id: 'syntax', kind: 'syntax', required: true, waivable: false, timeoutMs: 10000, integration: 'live' },
    { id: 'dependencies', kind: 'dependencies', required: true, waivable: true, timeoutMs: 10000, integration: 'live' },
    { id: 'typecheck', kind: 'command', role: 'typecheck', command: { program: 'node', args: [...compile,'--noEmit','src/app.ts'] }, required: true, waivable: false, timeoutMs: 15000, integration: 'live' },
    { id: 'build', kind: 'command', role: 'build', command: { program: 'node', args: [...compile,'--outDir','dist','src/app.ts'] }, required: true, waivable: false, timeoutMs: 15000, integration: 'live' },
    { id: 'tests', kind: 'command', role: 'test', command: { program: 'node', args: ['--test','--test-reporter=tap','tests/app.test.cjs'] }, testReport: { format: 'tap', minimumTests: 1 }, required: true, waivable: false, timeoutMs: 15000, integration: 'live' },
    { id: 'lint', kind: 'command', role: 'lint', command: { program: 'node', args: ['lint.cjs'] }, required: true, waivable: false, timeoutMs: 10000, integration: 'live' },
    { id: 'codex_security', kind: 'codex_security', enabled: false, required: false, waivable: true, timeoutMs: 10000, integration: 'live' },
  ] };
  adjust?.(profile); repository.verification.register('fixture', profile, actor, 'Owner opted into exact host commands and hard gates');
  const submission = submissionFixture('task'); submission.spec.objective = 'Fix src/app.ts add(a,b) to return a+b while preserving existing tests'; submission.spec.acceptance = ['add(2,3) returns 5', 'Configured TypeScript, build, test and lint gates pass']; repository.submitTask(submission, actor);
  return { root, project, filename, repository, profile, async report(): Promise<GateReport> { const row = repository.verification.reports('task').filter(row => row.reportArtifactId).at(-1)!; const artifact = await repository.verifyStoredArtifact(row.reportArtifactId!); return JSON.parse(await readFile(join(repository.dataDirectory, artifact.location), 'utf8')); }, async cleanup() { repository.close(); await rm(root, { recursive: true, force: true }); } };
}
export function controlledEngineeringWorker(change?: (workspace: string) => Promise<void>): CodexExecutor {
  return { async run(input) {
    await writeFile(join(input.workspacePath, 'src/app.ts'), 'export function add(a: number, b: number): number { return a + b; }\n');
    await change?.(input.workspacePath);
    for (const event of [{ type: 'thread.started', thread_id: 'controlled-session' }, { type: 'turn.started' }, { type: 'item.completed', item: { id: 'msg', type: 'agent_message', text: 'Done. All checks pass (untrusted agent claim).' } }, { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }]) await input.onRawEvent(event);
    return { exitCode: 0, exitSignal: null, stderrTail: '', stderrTruncated: false, aborted: input.signal.aborted, spawned: false };
  } };
}
