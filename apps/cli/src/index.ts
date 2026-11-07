#!/usr/bin/env node
import { daemonCommand } from './daemon.js';
import { previewApply, confirmApply } from '../../../packages/core/src/apply.js';
import { userInfo } from 'node:os';
import { TaskRepository } from '../../../packages/persistence/src/task-repository.js';
import { verificationTaskDetails } from '../../../packages/core/src/verification-details.js';
import { parseArgs } from 'node:util';
import { readFile, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { EnvironmentOptions } from '../../../packages/environment/src/types.js';
import { CodexSdkAdapter } from '../../../packages/agents/src/codex-sdk.adapter.js';
import { runTask, resumeTask, databasePath } from '../../../packages/core/src/orchestrator.js';
import { startTerminal, login } from './terminal.js';
import { doctor } from './doctor.js';
import { CodexSecurityAdapter } from '../../../packages/security/src/codex-security.adapter.js';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { TaskStore } from '../../../packages/persistence/src/database.js';
import { createBackup, restoreBackup } from '../../../packages/persistence/src/backup.js';
export async function main(args = process.argv.slice(2)): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    repo: { type: 'string', default: '.' }, acceptance: { type: 'string' }, typecheck: { type: 'string' }, 'security-check': { type: 'string' }, 'browser-check': { type: 'string' }, confirm: { type: 'string' }, 'allow-host-fallback': { type: 'boolean' }, output: { type: 'string' }, build: { type: 'string' }, test: { type: 'string' },
    execution: { type: 'string' }, image: { type: 'string' }, services: { type: 'string' }, 'max-recoveries': { type: 'string' }, 'allow-image-pull': { type: 'boolean' }, 'allow-dependency-install': { type: 'boolean' },
    model: { type: 'string' }, timeout: { type: 'string' }, plan: { type: 'string' }, 'max-repairs': { type: 'string' },
    database: { type: 'string' }, project: { type: 'string' }, step: { type: 'string' }, reason: { type: 'string' }, expires: { type: 'string' }, revision: { type: 'string' }, 'report-format': { type: 'string' }, plain: { type: 'boolean' }, version: { type: 'boolean', short: 'v' }, help: { type: 'boolean', short: 'h' },
  } });
  const [command, argument] = positionals;
  if (values.version) { console.log('ctx 0.1.0'); return 0; }
  if (values.help) {
    console.log('Daemon: ctx daemon start|stop|status|query --database <sqlite>\n        ctx daemon submit <submission.json> --database <sqlite>\n        ctx daemon pause|resume|cancel|retry <task-id> --revision <n> --database <sqlite>');
    console.log('Verification: ctx profile <profile.json> --project <id> --database <sqlite>\n              ctx details <task-id> --database <sqlite> [--report-format json|markdown]\n              ctx waive <task-id> --step <id> --revision <n> --reason <text> --expires <ISO> --database <sqlite>');
    console.log('Storage: ctx backup <new-directory> --database <sqlite-file>\n         ctx restore <backup-directory> --output <new-directory>');
    console.log('ctx — local engineering workspace\nUsage: ctx [--repo path]              Open the terminal interface (--plain for line mode)\n       ctx doctor                    Check local prerequisites\n       ctx login                     Sign in to the connected provider\n       ctx security --repo path      Run an explicit security review\n\nctx run "request" --repo . [--build "command"] [--test "command"] [--output path] [--model model] [--timeout seconds] [--plan plan.json] [--max-repairs 0] [--execution docker|host|auto] [--allow-host-fallback] [--acceptance criteria.json] [--typecheck command] [--security-check command] [--browser-check command] [--image image] [--services services.json] [--max-recoveries 3] [--allow-image-pull] [--allow-dependency-install]\nctx status [task-id] --repo . [--output path]\nctx resume <task-id> --repo . [--output path]\nctx logs <task-id> --repo . [--output path]\nctx diff <task-id> --repo . [--output path]\nctx apply <task-id> --repo . [--confirm preview-token]'); return 0;
  }
  if (command === 'backup' || command === 'restore') {
    if (positionals.length !== 2 || !argument || (command === 'backup' ? !values.database || values.output !== undefined : !values.output || values.database !== undefined)) throw new Error('Use ctx backup <new-directory> --database <sqlite-file>, or ctx restore <backup-directory> --output <new-directory>');
    for (const [name, value] of Object.entries(values)) if (value !== undefined && !['repo', command === 'backup' ? 'database' : 'output'].includes(name)) throw new Error('Backup/restore accepts only its documented storage options');
    if (command === 'backup') {
      const result = await createBackup(values.database!, argument);
      console.log(JSON.stringify({ directory: result.directory, manifest: join(result.directory, 'snapshot', 'manifest.json'), files: result.manifest.files.length }, null, 2));
    } else console.log(JSON.stringify(await restoreBackup(argument, values.output!), null, 2));
    return 0;
  }
  if (command === 'daemon' || command === 'doctor' && values.database) {
    if (!values.database) throw new Error('Daemon commands require --database');
    return daemonCommand(command === 'doctor' ? 'status' : argument ?? 'status', values.database, positionals[2], {revision:values.revision,reason:values.reason});
  }
  if (['profile','details','waive'].includes(command ?? '')) {
    if (positionals.length !== 2 || !argument || !values.database) throw new Error('Verification commands require one profile file/task ID and --database');
    await access(resolve(values.database)); const repository = await TaskRepository.open(values.database);
    const actor = { actorId: `local:${process.getuid?.() ?? userInfo().username}`, source: 'cli' as const, requestId: randomUUID() };
    try {
      if (command === 'profile') {
        if (!values.project) throw new Error('Profile registration requires --project');
        console.log(JSON.stringify(repository.verification.register(values.project, JSON.parse(await readFile(argument, 'utf8')), actor, 'Local owner explicitly registered exact verification gates'), null, 2));
      } else if (command === 'waive') {
        if (!values.step || !values.revision || !values.reason || !values.expires) throw new Error('Waiver requires --step, --revision, --reason and --expires; it applies only to the next attempt');
        console.log(JSON.stringify(repository.verification.grantWaiver(argument, Number(values.revision), values.step, values.reason, values.expires, actor), null, 2));
      } else {
        if (values['report-format'] && !['json','markdown'].includes(values['report-format'])) throw new Error('Report format must be json or markdown');
        const details = await verificationTaskDetails(repository, argument);
        if (values['report-format'] === 'markdown') {
          if (!details.markdownArtifactId) throw new Error('No engineering verification report is available');
          const descriptor = await repository.verifyStoredArtifact(details.markdownArtifactId);
          console.log(`Task: ${argument}\nState: ${details.task.state}\n\n${await readFile(join(repository.dataDirectory, descriptor.location), 'utf8')}`);
        } else console.log(JSON.stringify(details, null, 2));
      }
      return 0;
    } finally { repository.close(); }
  }
  if (values.database !== undefined) throw new Error('--database is supported by backup and documented verification commands');
  if (!command || command === 'ui') {
    if (command === 'ui' && positionals.length > 1) throw new Error('Use ctx ui --repo path');
    if (values.execution && !['docker', 'host', 'auto'].includes(values.execution)) throw new Error('Execution must be docker, host or auto');
    return startTerminal({ plain: values.plain, repositoryPath: values.repo, execution: (values.execution ?? 'auto') as EnvironmentOptions['mode'], environment: { allowHostFallback: values['allow-host-fallback'], allowImagePull: values['allow-image-pull'], allowDependencyInstall: values['allow-dependency-install'] }, build: values.build, test: values.test, typecheck: values.typecheck, security: values['security-check'], browser: values['browser-check'], acceptance: values.acceptance ? JSON.parse(await readFile(values.acceptance, 'utf8')) : undefined });
  }
  if (command === 'doctor' || command === 'login' || command === 'security') {
    if (positionals.length > 1) throw new Error(`Use ctx ${command} [--repo path]`);
    if (command === 'doctor') return doctor();
    if (command === 'login') return login();
    const result = await new CodexSecurityAdapter().scan({ repositoryPath: resolve(values.repo!), outputDirectory: join(tmpdir(), `ctx-security-${randomUUID()}`) });
    console.log(JSON.stringify(result, null, 2)); return result.status === 'passed' ? 0 : 1;
  }
  if (positionals.length > 2 || (command !== 'status' && !argument?.trim())) throw new Error('Expected a command and one request or task ID');
  const root = resolve(values.output ?? join(values.repo!, '.harness'));
  if (command !== 'run' && argument && !/^[a-f0-9-]{36}$/.test(argument)) throw new Error('Invalid task ID');
  if (command === 'apply') {
    await access(databasePath(root));
    const result = values.confirm ? await confirmApply(databasePath(root), argument!, resolve(values.repo!), values.confirm) : await previewApply(databasePath(root), argument!, resolve(values.repo!));
    console.log(JSON.stringify(result, null, 2)); return 'conflicts' in result && result.conflicts.length ? 1 : 0;
  }
  if (command === 'run' || command === 'resume') {
    const timeoutMs = values.timeout === undefined ? undefined : Number(values.timeout) * 1000;
    if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647)) throw new Error('Timeout must be a positive number of seconds');
    const maxRepairAttempts = values['max-repairs'] === undefined ? undefined : Number(values['max-repairs']);
    if (maxRepairAttempts !== undefined && (!Number.isInteger(maxRepairAttempts) || maxRepairAttempts < 0 || maxRepairAttempts > 10)) throw new Error('Repair budget must be an integer from 0 to 10');
    let model = values.model;
    if (command === 'resume') {
      if (['acceptance', 'typecheck', 'security-check', 'browser-check', 'allow-host-fallback', 'build', 'test', 'model', 'timeout', 'plan', 'max-repairs', 'execution', 'image', 'services', 'max-recoveries', 'allow-image-pull', 'allow-dependency-install'].some(key => values[key as keyof typeof values] !== undefined)) throw new Error('Resume uses persisted configuration; run options cannot be changed');
      await access(databasePath(root)); const store = new TaskStore(databasePath(root));
      try { model = store.get(argument!).model; } finally { store.close(); }
    }
    const controller = new AbortController(); const abort = () => controller.abort();
    process.once('SIGINT', abort); process.once('SIGTERM', abort);
    try {
      const adapter = new CodexSdkAdapter(undefined, model);
      const result = command === 'resume'
        ? await resumeTask({ id: argument!, outputDirectory: root, signal: controller.signal }, adapter)
        : await runTask({ request: argument!, repositoryPath: values.repo!, outputDirectory: root, build: values.build, test: values.test, typecheck: values.typecheck, security: values['security-check'], browser: values['browser-check'], acceptance: values.acceptance ? JSON.parse(await readFile(values.acceptance, 'utf8')) : undefined, timeoutMs, signal: controller.signal, model, maxRepairAttempts,
          environment: { mode: (values.execution ?? 'auto') as EnvironmentOptions['mode'], allowHostFallback: values['allow-host-fallback'], image: values.image, allowImagePull: values['allow-image-pull'], allowDependencyInstall: values['allow-dependency-install'], maxRecoveryAttempts: values['max-recoveries'] === undefined ? undefined : Number(values['max-recoveries']), services: values.services ? JSON.parse(await readFile(values.services, 'utf8')) : undefined },
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
