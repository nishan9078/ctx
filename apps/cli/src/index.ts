#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CodexSdkAdapter } from '../../../packages/agents/src/codex-sdk.adapter.js';
import { runTask } from '../../../packages/core/src/orchestrator.js';
export async function main(args = process.argv.slice(2)): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    repo: { type: 'string', default: '.' }, output: { type: 'string' }, build: { type: 'string' }, test: { type: 'string' },
    model: { type: 'string' }, timeout: { type: 'string' }, help: { type: 'boolean', short: 'h' },
  } });
  const [command, argument] = positionals;
  if (values.help || !command) {
    console.log('harness run "request" --repo . [--build "command"] [--test "command"] [--output path] [--model model] [--timeout seconds]\nharness status <task-id> --repo . [--output path]\nharness logs <task-id> --repo . [--output path]\nharness diff <task-id> --repo . [--output path]'); return 0;
  }
  if (positionals.length !== 2 || !argument?.trim()) throw new Error('Expected a command and one request or task ID');
  if (command === 'run') {
    const timeoutMs = values.timeout === undefined ? undefined : Number(values.timeout) * 1000;
    if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647)) throw new Error('Timeout must be a positive number of seconds');
    const controller = new AbortController(); const abort = () => controller.abort();
    process.once('SIGINT', abort); process.once('SIGTERM', abort);
    try {
      const result = await runTask({ request: argument, repositoryPath: values.repo!, outputDirectory: values.output, build: values.build, test: values.test, timeoutMs, signal: controller.signal }, new CodexSdkAdapter(undefined, values.model));
      console.log(JSON.stringify({ outcome: result.report.outcome, taskId: result.report.id, report: join(result.directory, 'report.json'), workspace: result.report.workspacePath }, null, 2));
      return result.report.outcome === 'completed' ? 0 : result.report.outcome === 'cancelled' ? 130 : 1;
    } finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
  }
  if (!['status', 'logs', 'diff'].includes(command)) throw new Error(`Unsupported Milestone 1 command: ${command}`);
  if (!/^[a-f0-9-]{36}$/.test(argument)) throw new Error('Invalid task ID');
  const directory = resolve(values.output ?? join(values.repo!, '.harness'), argument);
  console.log(await readFile(join(directory, command === 'logs' ? 'events.jsonl' : command === 'diff' ? 'changes.diff' : 'report.json'), 'utf8'));
  return 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(code => { process.exitCode = code; }).catch(error => { console.error(String(error)); process.exitCode = 1; });
}
