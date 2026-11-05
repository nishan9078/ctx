#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { EnvironmentOptions } from '../../../packages/environment/src/types.js';
import { CodexSdkAdapter } from '../../../packages/agents/src/codex-sdk.adapter.js';
import { runTask, resumeTask, databasePath } from '../../../packages/core/src/orchestrator.js';
import { TaskStore } from '../../../packages/persistence/src/database.js';
export async function main(args = process.argv.slice(2)): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    repo: { type: 'string', default: '.' }, output: { type: 'string' }, build: { type: 'string' }, test: { type: 'string' },
    execution: { type: 'string' }, image: { type: 'string' }, services: { type: 'string' }, 'max-recoveries': { type: 'string' }, 'allow-image-pull': { type: 'boolean' }, 'allow-dependency-install': { type: 'boolean' },
    model: { type: 'string' }, timeout: { type: 'string' }, plan: { type: 'string' }, 'max-repairs': { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  } });
  const [command, argument] = positionals;
  if (values.help || !command) {
    console.log('harness run "request" --repo . [--build "command"] [--test "command"] [--output path] [--model model] [--timeout seconds] [--plan plan.json] [--max-repairs 0] [--execution docker|host] [--image image] [--services services.json] [--max-recoveries 3] [--allow-image-pull] [--allow-dependency-install]\nharness status [task-id] --repo . [--output path]\nharness resume <task-id> --repo . [--output path]\nharness logs <task-id> --repo . [--output path]\nharness diff <task-id> --repo . [--output path]'); return 0;
  }
  if (positionals.length > 2 || (command !== 'status' && !argument?.trim())) throw new Error('Expected a command and one request or task ID');
  const root = resolve(values.output ?? join(values.repo!, '.harness'));
  if (command !== 'run' && argument && !/^[a-f0-9-]{36}$/.test(argument)) throw new Error('Invalid task ID');
  if (command === 'run' || command === 'resume') {
    const timeoutMs = values.timeout === undefined ? undefined : Number(values.timeout) * 1000;
    if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647)) throw new Error('Timeout must be a positive number of seconds');
    const maxRepairAttempts = values['max-repairs'] === undefined ? undefined : Number(values['max-repairs']);
    if (maxRepairAttempts !== undefined && (!Number.isInteger(maxRepairAttempts) || maxRepairAttempts < 0 || maxRepairAttempts > 10)) throw new Error('Repair budget must be an integer from 0 to 10');
    let model = values.model;
    if (command === 'resume') {
      if (['build', 'test', 'model', 'timeout', 'plan', 'max-repairs', 'execution', 'image', 'services', 'max-recoveries', 'allow-image-pull', 'allow-dependency-install'].some(key => values[key as keyof typeof values] !== undefined)) throw new Error('Resume uses persisted configuration; run options cannot be changed');
      await access(databasePath(root)); const store = new TaskStore(databasePath(root));
      try { model = store.get(argument!).model; } finally { store.close(); }
    }
    const controller = new AbortController(); const abort = () => controller.abort();
    process.once('SIGINT', abort); process.once('SIGTERM', abort);
    try {
      const adapter = new CodexSdkAdapter(undefined, model);
      const result = command === 'resume'
        ? await resumeTask({ id: argument!, outputDirectory: root, signal: controller.signal }, adapter)
        : await runTask({ request: argument!, repositoryPath: values.repo!, outputDirectory: root, build: values.build, test: values.test, timeoutMs, signal: controller.signal, model, maxRepairAttempts,
          environment: { mode: values.execution as EnvironmentOptions['mode'], image: values.image, allowImagePull: values['allow-image-pull'], allowDependencyInstall: values['allow-dependency-install'], maxRecoveryAttempts: values['max-recoveries'] === undefined ? undefined : Number(values['max-recoveries']), services: values.services ? JSON.parse(await readFile(values.services, 'utf8')) : undefined },
          plan: values.plan ? JSON.parse(await readFile(values.plan, 'utf8')) : undefined }, adapter);
      console.log(JSON.stringify({ outcome: result.report.outcome, taskId: result.report.id, report: join(result.directory, 'report.json'), workspace: result.report.workspacePath }, null, 2));
      return result.report.outcome === 'completed' ? 0 : result.report.outcome === 'cancelled' ? 130 : 1;
    } finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
  }
  if (!['status', 'logs', 'diff'].includes(command)) throw new Error(`Unsupported command: ${command}`);
  await access(databasePath(root));
  const store = new TaskStore(databasePath(root));
  try {
    if (command === 'status') {
      console.log(JSON.stringify(argument ? store.get(argument) : store.list().map(task => ({ id: task.id, status: task.status, request: task.request, updatedAt: task.updatedAt })), null, 2));
    } else if (command === 'logs') { store.get(argument!); console.log(store.events(argument!).map(event => JSON.stringify(event)).join('\n')); }
    else console.log(await readFile(join(store.get(argument!).directory, 'changes.diff'), 'utf8'));
  } finally { store.close(); }
  return 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(code => { process.exitCode = code; }).catch(error => { console.error(String(error)); process.exitCode = 1; });
}
