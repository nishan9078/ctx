import { access, readFile, realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { TaskStore, type StoredEvent } from '../../../packages/persistence/src/database.js';
import { databasePath } from '../../../packages/core/src/orchestrator.js';
import type { TaskRecord } from '../../../packages/core/src/types.js';
import { redact } from '../../../packages/shared/src/redact.js';
import { taskProgress } from './terminal-view.js';
import type { Activity, TerminalContext } from './terminal-model.js';
const exec = promisify(execFile);
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};
export interface EngineSnapshot { task: TaskRecord; context: Partial<TerminalContext>; activities: Activity[] }
export async function inspectWorkspace(path: string): Promise<Pick<TerminalContext, 'repository' | 'branch' | 'workspaceWarning'>> {
  const repository = await realpath(path);
  let branch = 'no Git repository'; let git = false;
  try { const result = await exec('git', ['-C', repository, 'rev-parse', '--show-toplevel']); git = !!result.stdout.trim(); branch = (await exec('git', ['-C', repository, 'branch', '--show-current'])).stdout.trim() || 'detached HEAD'; } catch {}
  let marker = false;
  for (const name of ['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'Makefile', 'CMakeLists.txt', 'pom.xml', 'build.gradle', 'ARCHITECTURE.md']) {
    try { await access(join(repository, name)); marker = true; break; } catch {}
  }
  let release = false;
  try { release = JSON.parse(await readFile(join(repository, 'release-manifest.json'), 'utf8')).product === 'ctx'; } catch {}
  return { repository, branch, workspaceWarning: release ? 'Release bundle selected. Use /repo /path/to/project; engineering tasks cannot target the CTX installation.' : git || marker ? '' : 'Workspace warning: no Git repository or recognized project manifest. Use /repo to select an engineering workspace.' };
}
/** Read-only projection of durable engine state. UI modes never execute or replay events. */
export class TerminalEngineAdapter {
  constructor(readonly repository: string) {}
  async list(): Promise<TaskRecord[]> {
    const path = databasePath(join(this.repository, '.harness'));
    try { await access(path); } catch { return []; }
    const store = new TaskStore(path); try { return store.list(); } finally { store.close(); }
  }
  async snapshot(id: string): Promise<EngineSnapshot> {
    const store = new TaskStore(databasePath(join(this.repository, '.harness')));
    let task: TaskRecord; let events: StoredEvent[];
    try { task = store.get(id); events = store.events(id); } finally { store.close(); }
    const activities = events.map(event => journalActivity(id, event));
    for (const check of task.verification) {
      let output = 'Output artifact unavailable.';
      try { output = redact((await readFile(check.artifact, 'utf8')).slice(-50_000)); } catch {}
      activities.push({ id: `${id}:check:${check.name}:${check.artifact}`, title: `${check.name.toUpperCase()} ${check.status} · ${check.command}`, body: output, kind: 'tool', important: check.status !== 'passed' });
    }
    return { task, activities, context: { execution: task.environment?.selectedMode ?? task.environment?.config.mode ?? 'host',
      progress: taskProgress(task), plan: task.plan.steps.map(step => `${step.status === 'passed' ? '✓' : step.status === 'running' ? '›' : '·'} ${step.title} [${step.status}]`).join('\n'),
      checks: task.verification.map(check => `${check.name}: ${check.status}`).join('\n') || `Build / test: ${task.activeCheck ? `running ${task.activeCheck}` : 'not run'}`,
      recovery: task.environment?.recoveries.map(item => `${item.kind}: ${item.status}`).join('\n') || 'No recovery attempts',
    } };
  }
}
export function journalActivity(taskId: string, event: StoredEvent): Activity {
  const data = object(event.data); const item = object(data.item);
  const labels: Record<string, string> = { 'task.queued': 'Task queued', 'task.planning': 'Planning request', 'plan.accepted': 'Plan accepted', 'task.preparing': 'Preparing workspace', 'workspace.prepared': 'Workspace ready', 'task.executing': 'Coding', 'task.verifying': 'Running checks', 'task.repairing': 'Repairing changes', 'task.completed': 'Task completed', 'task.cancelled': 'Task cancelled', 'task.blocked': 'Task blocked', 'task.failed': 'Task failed', 'environment.recovery.intent': 'Starting recovery', 'environment.recovery.result': 'Recovery result' };
  let title = labels[event.type] ?? event.type; let body = JSON.stringify(event.data, null, 2); let kind: Activity['kind'] = 'event'; let important = false;
  if (item.type === 'agent_message') { title = String(item.text ?? ''); kind = 'message'; body = ''; }
  else if (item.type === 'command_execution') { title = `${item.status ?? event.type} · ${item.command ?? 'Command'}`; body = String(item.aggregated_output ?? '') || body; kind = 'tool'; important = item.status === 'failed' || typeof item.exit_code === 'number' && item.exit_code !== 0; }
  else if (item.type === 'file_change') { title = `File changes · ${item.status ?? ''}`; kind = 'diff'; important = true; }
  else if (typeof item.type === 'string') { title = `${item.type} · ${item.status ?? event.type}`; kind = 'tool'; }
  else if (/blocked|failed|error/.test(event.type)) { kind = 'error'; important = true; }
  else if (/task\.repairing|recovery.result/.test(event.type)) important = true;
  // Updated SDK items replace the same activity; journal-only events retain sequence identity.
  if (event.type.startsWith('codex.')) { title = event.type.replace('codex.', 'Codex ').replaceAll('.', ' ') + (item.command ? ` · ${item.command}` : ''); important = true; }
  if (event.type === 'verification.started' || event.type === 'verification.completed') { title = event.type.replaceAll('.', ' '); important = true; }
  const id = event.type.startsWith('codex.') ? `${taskId}:lifecycle:${event.sequence}` : typeof item.id === 'string' ? `${taskId}:item:${item.id}` : `${taskId}:event:${event.sequence}`;
  return { id, title: redact(title), body: redact(body), kind, important };
}
