import { createInterface, cursorTo, clearLine } from 'node:readline';
import { readFile, stat, realpath, access } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { CodexSdkAdapter } from '../../../packages/agents/src/codex-sdk.adapter.js';
import { runTask, resumeTask, databasePath } from '../../../packages/core/src/orchestrator.js';
import type { RunInput } from '../../../packages/core/src/orchestrator.js';
import type { TaskRecord } from '../../../packages/core/src/types.js';
import { TaskStore } from '../../../packages/persistence/src/database.js';
import type { SecurityResult } from '../../../packages/security/src/security-adapter.js';
import { CodexSecurityAdapter } from '../../../packages/security/src/codex-security.adapter.js';
import { terminalHelp, taskProgress, reportView, securityView, safeText } from './terminal-view.js';
export function codexEntrypoint(): string {
  const sdk = createRequire(import.meta.resolve('@openai/codex-sdk'));
  return join(dirname(sdk.resolve('@openai/codex/package.json')), 'bin', 'codex.js');
}
export async function login(signal?: AbortSignal): Promise<number> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [codexEntrypoint(), 'login', '--device-auth'], { stdio: 'inherit', signal });
    child.on('error', reject); child.on('exit', code => resolveResult(code ?? 1));
  });
}
export async function startTerminal(initial: { repositoryPath?: string; execution?: 'docker' | 'host' } = {}): Promise<number> {
  let repository = await realpath(initial.repositoryPath ?? process.cwd());
  let lastSecurity: SecurityResult | undefined; let lastId: string | undefined; let lastDirectory: string | undefined;
  const settings: Pick<RunInput, 'build' | 'test' | 'maxRepairAttempts' | 'environment'> = { maxRepairAttempts: 1, environment: { mode: initial.execution ?? 'docker', allowImagePull: false, allowDependencyInstall: false } };
  let active: AbortController | undefined; let work: Promise<void> | undefined; let closing = false;
  const input = createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY && !!process.stdout.isTTY });
  const color = !!process.stdout.isTTY && !process.env.NO_COLOR;
  const write = (message: string) => {
    if (color) { cursorTo(process.stdout, 0); clearLine(process.stdout, 0); }
    process.stdout.write(safeText(message) + '\n');
  };
  const prompt = () => { if (!closing) { input.setPrompt(color ? '\x1b[36mctx ›\x1b[0m ' : 'ctx > '); input.prompt(true); } };
  const openStore = () => new TaskStore(databasePath(join(repository, '.harness')));
  const tasks = async (): Promise<TaskRecord[]> => {
    try { await access(databasePath(join(repository, '.harness'))); } catch { return []; }
    const store = openStore(); try { return store.list(); } finally { store.close(); }
  };
  const choose = async (id?: string) => {
    const records = await tasks(); const task = id ? records.find(item => item.id === id) : records.find(item => item.id === lastId) ?? records[0];
    if (!task) throw new Error('No saved task found. Describe a change to begin.'); return task;
  };
  const monitor = (id?: string, existing = new Set<string>()) => {
    let previous = '';
    const timer = setInterval(() => { void tasks().then(records => {
      const task = id ? records.find(item => item.id === id) : records.find(item => !existing.has(item.id));
      if (!task) return;
      lastId = task.id; lastDirectory = task.directory;
      const progress = taskProgress(task); if (progress !== previous) { previous = progress; write(`  ${progress}`); prompt(); }
    }).catch(() => {}); }, 500);
    return () => clearInterval(timer);
  };
  const executeTask = async (request?: string, resumeId?: string) => {
    lastSecurity = undefined;
    const existing = new Set((await tasks()).map(task => task.id));
    const stop = monitor(resumeId, existing);
    try {
      const model = resumeId ? (await choose(resumeId)).model : undefined;
      const result = resumeId
        ? await resumeTask({ id: resumeId, outputDirectory: join(repository, '.harness'), signal: active!.signal }, new CodexSdkAdapter(undefined, model))
        : await runTask({ request: request!, repositoryPath: repository, ...settings, signal: active!.signal }, new CodexSdkAdapter());
      lastId = result.report.id; lastDirectory = result.directory; write('\n' + reportView(result.report));
    } finally { stop(); }
  };
  const command = async (line: string) => {
    const [name, ...pieces] = line.trim().split(/\s+/); const argument = pieces.join(' ');
    if (!line.startsWith('/')) { await executeTask(line); return; }
    switch (name) {
      case '/help': write(terminalHelp); break;
      case '/quit': input.close(); break;
      case '/repo': {
        if (!argument) throw new Error('Use /repo /path/to/project');
        const target = await realpath(resolve(argument)); if (!(await stat(target)).isDirectory()) throw new Error('Repository path must be a directory');
        repository = target; lastSecurity = undefined; lastId = undefined; lastDirectory = undefined; write(`Repository: ${repository}`); break;
      }
      case '/tasks': {
        const records = await tasks(); write(records.slice(0, 8).map(task => `${task.id}  ${task.status.padEnd(10)} ${task.request.slice(0, 80)}`).join('\n') || 'No tasks yet.'); break;
      }
      case '/status': {
        const task = await choose(argument || undefined); lastId = task.id; lastDirectory = task.directory;
        write(`${task.id}\n${taskProgress(task)}${task.report ? '\n' + reportView(task.report) : ''}`); break;
      }
      case '/diff': { const task = await choose(argument || undefined); write(await readFile(join(task.directory, 'changes.diff'), 'utf8') || 'No file changes recorded.'); break; }
      case '/details': { if (!argument && lastSecurity) { write(JSON.stringify(lastSecurity, null, 2)); break; } const task = await choose(argument || undefined); write(JSON.stringify(task.report ?? task, null, 2)); break; }
      case '/resume': if (!argument) throw new Error('Use /resume <task-id>'); else await executeTask(undefined, argument); break;
      case '/security': {
        let target = repository;
        if (lastId) target = (await choose(lastId)).workspacePath;
        const outputDirectory = join(tmpdir(), `ctx-security-${randomUUID()}`);
        write('Security review started. Estimated scan budget: $1; this is not a billing cap.');
        const result = await new CodexSecurityAdapter().scan({ repositoryPath: target, outputDirectory, changesOnly: !!lastId, signal: active!.signal, onProgress: message => write(`  ${message}`) });
        lastSecurity = result; write(securityView(result)); write(`Scan evidence: ${outputDirectory}`); break;
      }
      case '/login': write('Sign in to the connected provider. Authentication happens in its own sign-in flow.'); await login(active!.signal); break;
      case '/config': write(`Repository: ${repository}\n${JSON.stringify(settings, null, 2)}\nSecurity scans are explicit via /security; they do not change task completion status.`); break;
      case '/set': {
        const [key, ...rest] = pieces; const value = rest.join(' ');
        if (key === 'execution' && ['docker', 'host'].includes(value)) settings.environment!.mode = value as 'docker' | 'host';
        else if (['pull', 'install'].includes(key) && ['on', 'off'].includes(value)) settings.environment![key === 'pull' ? 'allowImagePull' : 'allowDependencyInstall'] = value === 'on';
        else if (key === 'repairs' && /^\d+$/.test(value) && Number(value) <= 10) settings.maxRepairAttempts = Number(value);
        else if (key === 'build' || key === 'test') settings[key] = value || undefined;
        else throw new Error('Invalid setting. Use /help for supported settings.');
        write(`Updated ${key}.`); break;
      }
      default: throw new Error(`Unknown command ${name}. Use /help.`);
    }
  };
  write('\n  CTX\n  Your local engineering workspace\n');
  write(`Repository: ${repository}\nExecution: ${settings.environment!.mode} · Security: not run\n\nDescribe a change, or type /help.\n`);
  return new Promise(resolveResult => {
    input.on('line', line => {
      const request = line.trim(); if (request === '/quit') { input.close(); return; } if (!request) { prompt(); return; }
      if (request === '/cancel') { active?.abort(); write(active ? 'Stopping active work…' : 'No active work.'); prompt(); return; }
      if (active) { write('Work is running. Use /cancel or Ctrl-C to stop it.'); prompt(); return; }
      active = new AbortController();
      work = command(request).catch(error => { write(`Could not finish: ${safeText(error instanceof Error ? error.message : error)}`); if (lastDirectory) write(`Evidence: ${lastDirectory}`); }).finally(() => { active = undefined; work = undefined; prompt(); });
    });
    input.on('SIGINT', () => { if (active && !active.signal.aborted) { active.abort(); write('Stopping active work…'); } else input.close(); });
    input.on('close', () => { closing = true; active?.abort(); void (work ?? Promise.resolve()).finally(() => { write('\nSession closed.'); process.stdin.pause(); process.stdin.unref?.(); resolveResult(0); }); });
    prompt();
  });
}
