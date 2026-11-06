import { previewApply, confirmApply } from '../../../packages/core/src/apply.js';
import { databasePath } from '../../../packages/core/src/orchestrator.js';
import { createTerminalSurface, type TerminalSurface } from './terminal-surface.js';
import { readFile, stat, realpath } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { EnvironmentOptions, DockerDriver } from '../../../packages/environment/src/types.js';
import type { AcceptanceCriterion } from '../../../packages/verification/src/policy.js';
import { CodexSdkAdapter } from '../../../packages/agents/src/codex-sdk.adapter.js';
import type { AgentAdapter } from '../../../packages/agents/src/agent-adapter.js';
import { runTask, resumeTask, type RunInput } from '../../../packages/core/src/orchestrator.js';
import type { SecurityResult } from '../../../packages/security/src/security-adapter.js';
import { CodexSecurityAdapter } from '../../../packages/security/src/codex-security.adapter.js';
import { terminalHelp, reportView, securityView, safeText } from './terminal-view.js';
import { TerminalEngineAdapter, inspectWorkspace } from './terminal-engine.js';
import { loadDisplayMode, saveDisplayMode } from './terminal-preferences.js';
import type { DisplayMode } from './terminal-model.js';
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
export interface TerminalDependencies { docker?: DockerDriver; surface?: TerminalSurface; agent?: (model?: string) => AgentAdapter }
export async function startTerminal(initial: { repositoryPath?: string; execution?: EnvironmentOptions['mode']; environment?: EnvironmentOptions; build?: string; test?: string; typecheck?: string; security?: string; browser?: string; acceptance?: AcceptanceCriterion[]; plain?: boolean } = {}, dependencies: TerminalDependencies = {}): Promise<number> {
  const launchDirectory = await realpath(process.cwd());
  let repository = await realpath(initial.repositoryPath ?? launchDirectory);
  const input = dependencies.surface ?? await createTerminalSurface(initial.plain);
  let engine = new TerminalEngineAdapter(repository);
  let lastSecurity: SecurityResult | undefined; let lastId: string | undefined; let lastDirectory: string | undefined;
  const settings: Pick<RunInput, 'build' | 'test' | 'typecheck' | 'security' | 'browser' | 'acceptance' | 'maxRepairAttempts' | 'environment'> = { maxRepairAttempts: 1, build: initial.build, test: initial.test, typecheck: initial.typecheck, security: initial.security, browser: initial.browser, acceptance: initial.acceptance, environment: { mode: initial.execution ?? 'auto', allowImagePull: false, allowDependencyInstall: false, ...initial.environment } };
  let active: AbortController | undefined; let work: Promise<void> | undefined; let closing = false;
  const reads = new Set<Promise<void>>(); let preferenceWork = Promise.resolve();
  const write = (message: string) => input.write(message);
  const prompt = () => { if (!closing) input.prompt(); };
  const update = (configured = false) => input.update({ repository, ...(configured ? { execution: settings.environment!.mode! } : {}), busy: !!active });
  const saveMode = (mode: DisplayMode) => {
    const target = repository;
    preferenceWork = preferenceWork.then(() => saveDisplayMode(target, mode)).catch(error => write(`Could not save display preference: ${safeText(error.message)}`));
  };
  const selectRepository = async () => {
    input.update({ ...await inspectWorkspace(repository), launchDirectory, executableDirectory: process.env.CTX_EXECUTABLE_DIR ?? dirname(process.execPath), progress: 'Ready', security: 'not run', plan: '', checks: 'Build / test: not run', recovery: '' });
    input.model.setMode(await loadDisplayMode(repository)); update(true);
  };
  try { await selectRepository(); } catch (error) { await input.destroy(); throw error; }
  input.model.on('mode', saveMode);
  const choose = async (id?: string) => {
    const records = await engine.list(); const task = id ? records.find(item => item.id === id) : records.find(item => item.id === lastId) ?? records[0];
    if (!task) throw new Error('No saved task found. Describe a change to begin.'); return task;
  };
  const project = async (id: string) => {
    const snapshot = await engine.snapshot(id); input.update(snapshot.context); input.model.activities(snapshot.activities);
    return snapshot.task;
  };
  const monitor = (target: TerminalEngineAdapter, id?: string, existing = new Set<string>()) => {
    let polling = false; let stopped = false;
    const timer = setInterval(() => { if (polling) return; polling = true;
      void target.list().then(async records => {
        const task = id ? records.find(item => item.id === id) : records.find(item => !existing.has(item.id));
        if (!task || stopped) return;
        lastId = task.id; lastDirectory = task.directory;
        const snapshot = await target.snapshot(task.id); if (stopped) return;
        input.update(snapshot.context); input.model.activities(snapshot.activities);
      }).catch(error => { if (!stopped) input.activity({ id: 'journal-error', title: `Could not read task progress: ${safeText(error.message)}`, kind: 'error', important: true }); }).finally(() => { polling = false; });
    }, 250);
    return () => { stopped = true; clearInterval(timer); };
  };
  const agent = dependencies.agent ?? ((model?: string) => new CodexSdkAdapter(undefined, model));
  const executeTask = async (signal: AbortSignal, request?: string, resumeId?: string) => {
    lastSecurity = undefined; input.update({ security: 'not run', progress: 'Planning', plan: '' });
    const existing = new Set((await engine.list()).map(task => task.id)); const stop = monitor(engine, resumeId, existing);
    try {
      const model = resumeId ? (await choose(resumeId)).model : undefined;
      const result = resumeId
        ? await resumeTask({ id: resumeId, outputDirectory: join(repository, '.harness'), signal }, agent(model), { docker: dependencies.docker })
        : await runTask({ request: request!, repositoryPath: repository, ...settings, signal }, agent(), { docker: dependencies.docker });
      stop(); lastId = result.report.id; lastDirectory = result.directory; const task = await project(lastId);
      write(reportView(result.report));
      if (result.report.outcome === 'blocked' && !task.attempts.length) write('Codex did not start. Restore Docker access, or use /retry host to explicitly approve local verification and retry.');
      if (result.report.acceptance) write(`Verified artifacts are in ${result.report.workspacePath}. Empty folders are recorded in ${result.report.acceptance.manifest}; they do not appear in Git diffs.`);
      if (task.error || result.report.environment.diagnostic) input.activity({ id: `${lastId}:explanation`, title: task.error ?? 'Execution needs attention', body: result.report.nextActions.join('\n'), kind: 'error', important: true, expanded: true });
    } finally { stop(); }
  };
  const command = async (line: string, signal?: AbortSignal) => {
    const [name, ...pieces] = line.trim().split(/\s+/); const argument = pieces.join(' ');
    if (!line.startsWith('/')) { await executeTask(signal!, line); return; }
    switch (name) {
      case '/help': input.showHelp(terminalHelp); break;
      case '/mode': if (argument && !['minimal', 'detailed'].includes(argument)) throw new Error('Use /mode minimal|detailed'); else if (argument) input.model.setMode(argument as DisplayMode); else input.model.toggleMode(); break;
      case '/repo': {
        if (!argument) throw new Error('Use /repo /path/to/project');
        const target = await realpath(resolve(launchDirectory, argument)); if (!(await stat(target)).isDirectory()) throw new Error('Repository path must be a directory');
        repository = target; engine = new TerminalEngineAdapter(repository); lastSecurity = undefined; lastId = undefined; lastDirectory = undefined;
        input.model.removeListener('mode', saveMode); await selectRepository(); input.model.on('mode', saveMode); write(`Repository: ${repository}`); break;
      }
      case '/tasks': {
        const records = await engine.list(); write(records.slice(0, 8).map(task => `${task.id}  ${task.status.padEnd(10)} ${task.request.slice(0, 80)}`).join('\n') || 'No tasks yet.'); break;
      }
      case '/status': {
        const task = await choose(argument || undefined);
        if (!active) { lastId = task.id; lastDirectory = task.directory; await project(task.id); }
        write(`${task.id}\n${task.status}${task.error ? '\n' + task.error : ''}${task.report ? '\n' + reportView(task.report) : ''}`);
        try { const receipt = JSON.parse(await readFile(join(task.directory, 'apply-receipt.json'), 'utf8')); write(`Applied changes: ${receipt.paths.join(', ')} · backup ${receipt.backup}`); } catch {} break;
      }
      case '/apply': {
        const tokens = argument.split(/\s+/).filter(Boolean); const explicitId = tokens[0]?.startsWith('--') ? undefined : tokens[0];
        const task = await choose(explicitId); const position = tokens.indexOf('--confirm');
        if (position >= 0) {
          if (!tokens[position + 1] || tokens.length !== (explicitId ? 3 : 2)) throw new Error('Use /apply [id] --confirm <preview-token>');
          const result = await confirmApply(databasePath(join(repository, '.harness')), task.id, repository, tokens[position + 1]);
          write(`Applied verified changes: ${result.paths.join(', ')}\nReceipt: ${result.receipt}\nOriginal-file backup and journal: ${result.backup}\nGit index and commits were not changed.`);
        } else {
          if (tokens.length > (explicitId ? 1 : 0)) throw new Error('Use /apply [id] for a preview');
          const preview = await previewApply(databasePath(join(repository, '.harness')), task.id, repository);
          write(`APPLY PREVIEW · ${preview.target}\n${preview.entries.map(entry => `${entry.before ? entry.after ? 'MODIFY' : 'DELETE' : 'CREATE'} ${entry.path}`).join('\n') || 'No changes to transfer.'}\n${preview.conflicts.length ? 'CONFLICTS\n' + preview.conflicts.join('\n') : preview.token ? `Confirm this exact preview: /apply ${task.id} --confirm ${preview.token}` : ''}\n${preview.note}`);
        }
        break;
      }
      case '/diff': { const task = await choose(argument || undefined); const diff = await readFile(join(task.directory, 'changes.diff'), 'utf8'); input.inspect('File changes · Esc close', diff || 'No file changes recorded.'); break; }
      case '/details': { if (!argument && lastSecurity) input.inspect('Security evidence · Esc close', JSON.stringify(lastSecurity, null, 2)); else { const task = await choose(argument || undefined); input.inspect('Diagnostics · Esc close', JSON.stringify(task.report ?? task, null, 2)); } break; }
      case '/retry': {
        if (argument !== 'host') throw new Error('Use /retry host to explicitly approve host verification for a task blocked before Codex started.');
        const task = await choose();
        if (task.status !== 'blocked' || task.attempts.length || task.environment?.ready) throw new Error('Only an environment-blocked task with no Codex attempts may be retried this way. Inspect /details first.');
        settings.environment = { ...task.environment?.config, mode: 'host' }; settings.build = task.commands.build; settings.test = task.commands.test; settings.typecheck = task.commands.typecheck; settings.security = task.commands.security; settings.browser = task.commands.browser;
        settings.acceptance = task.verificationPolicy?.criteria.length ? task.verificationPolicy.criteria : undefined;
        write('Host verification explicitly approved. Project commands run locally as your user; Codex tools retain the SDK workspace sandbox.'); update(true);
        await executeTask(signal!, task.request); break;
      }
      case '/resume': if (!argument) throw new Error('Use /resume <task-id>'); else await executeTask(signal!, undefined, argument); break;
      case '/security': {
        let target = repository; if (lastId) target = (await choose(lastId)).workspacePath;
        const outputDirectory = join(tmpdir(), `ctx-security-${randomUUID()}`);
        input.update({ security: 'reviewing', progress: 'Security scanning' }); write('Security review started. Estimated scan budget: $1; this is not a billing cap.');
        const result = await new CodexSecurityAdapter().scan({ repositoryPath: target, outputDirectory, changesOnly: !!lastId, signal, onProgress: message => input.activity({ id: 'security-progress', title: message, kind: 'security', important: true }) });
        lastSecurity = result; input.update({ security: result.status, progress: `Security review ${result.status}` }); write(securityView(result)); write(`Scan evidence: ${outputDirectory}`); break;
      }
      case '/login': write('Sign in to the connected provider. Authentication happens in its own sign-in flow.'); await input.handoff(() => login(signal)); break;
      case '/config': write(`Repository: ${repository}\nLaunched from: ${launchDirectory}\n${JSON.stringify(settings, null, 2)}\nSecurity scans are explicit via /security; they do not change task completion status.`); break;
      case '/set': {
        const [key, ...rest] = pieces; const value = rest.join(' ');
        if (key === 'execution' && ['docker', 'host', 'auto'].includes(value)) settings.environment!.mode = value as EnvironmentOptions['mode'];
        else if (key === 'fallback' && ['on', 'off'].includes(value)) settings.environment!.allowHostFallback = value === 'on';
        else if (['pull', 'install'].includes(key) && ['on', 'off'].includes(value)) settings.environment![key === 'pull' ? 'allowImagePull' : 'allowDependencyInstall'] = value === 'on';
        else if (key === 'repairs' && /^\d+$/.test(value) && Number(value) <= 10) settings.maxRepairAttempts = Number(value);
        else if (key === 'build' || key === 'test' || key === 'typecheck' || key === 'security' || key === 'browser') settings[key] = value || undefined;
        else throw new Error('Invalid setting. Use /help for supported settings.');
        update(true); write(`Updated ${key}.`); break;
      }
      default: throw new Error(`Unknown command ${name}. Use /help.`);
    }
  };
  if (!input.screen) write('\n  CTX\n  Your local engineering workspace\n');
  write('Describe a change to begin. Use /help for commands.');
  if (input.model.context.workspaceWarning) write(input.model.context.workspaceWarning);
  return new Promise(resolveResult => {
    const errorView = (error: unknown) => input.activity({ id: `error-${randomUUID()}`, title: `Could not finish: ${safeText(error instanceof Error ? error.message : error)}`, body: lastDirectory ? `Evidence: ${lastDirectory}` : undefined, kind: 'error', important: true });
    const readOnly = new Set(['/help', '/tasks', '/status', '/diff', '/details', '/config', '/mode']);
    input.on('line', (line: string) => {
      const request = line.trim(); const name = request.split(/\s+/)[0];
      if (closing) return;
      if (request === '/quit') { input.close(); return; }
      if (!request) { prompt(); return; }
      if (request === '/cancel') { active?.abort(); write(active ? 'Stopping active work…' : 'No active work.'); prompt(); return; }
      if (readOnly.has(name)) {
        const read = command(request).catch(errorView).finally(() => { reads.delete(read); prompt(); }); reads.add(read); return;
      }
      if (active) { write('Work is running. Status, tasks, help, diff, details and mode commands remain available. Use /cancel before starting another task or changing execution settings.'); prompt(); return; }
      active = new AbortController(); update();
      work = command(request, active.signal).catch(errorView).finally(() => { active = undefined; work = undefined; update(); prompt(); });
    });
    input.on('SIGINT', () => { if (active && !active.signal.aborted) { active.abort(); write('Stopping active work…'); } else input.close(); });
    input.on('close', () => { if (closing) return; closing = true; active?.abort();
      void Promise.allSettled([work, ...reads]).then(async () => {
        input.model.removeListener('mode', saveMode); await preferenceWork;
        try { if (!input.screen) write('\nSession closed.'); await input.destroy(); resolveResult(0); } catch { resolveResult(1); }
        finally { process.stdin.pause(); process.stdin.unref?.(); }
      });
    });
    prompt();
  });
}
