import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { TerminalSurface, type TerminalContext } from '../../apps/cli/src/terminal-surface.js';
import { startTerminal } from '../../apps/cli/src/terminal.js';
import { TerminalEngineAdapter, inspectWorkspace } from '../../apps/cli/src/terminal-engine.js';
class Surface extends TerminalSurface {
  ready = false; destroyed = false;
  write(message: string): void { this.model.write(message); }
  prompt(): void { this.ready = true; }
  close(): void { this.emit('close'); }
  async destroy(): Promise<void> { this.destroyed = true; }
  update(context: Partial<TerminalContext>): void { this.model.update(context); }
}
async function until(predicate: () => boolean): Promise<void> {
  const end = Date.now() + 8000;
  while (!predicate()) { if (Date.now() > end) throw new Error('Timed out waiting for UI state'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
test('journal adapter updates during execution; slash commands and modes work while overlapping tasks are refused', { timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'ctx-controller-')); const repository = join(root, 'project'); await mkdir(repository);
  await writeFile(join(repository, 'package.json'), '{"scripts":{"build":"true","test":"true"}}');
  const surface = new Surface(); let turns = 0; let running = false; let workspace: string | undefined;
  const session = startTerminal({ repositoryPath: repository, execution: 'host' }, { surface, agent: () => ({ async execute(input) {
    turns++; workspace = input.workspacePath;
    await input.onEvent?.({ type: 'item.started', data: { item: { id: 'cmd-1', type: 'command_execution', command: 'inspect project', status: 'in_progress', aggregated_output: 'Working output' } } });
    running = true;
    await new Promise<void>(resolve => { if (input.signal?.aborted) resolve(); else input.signal?.addEventListener('abort', () => resolve(), { once: true }); });
    return { outcome: 'interrupted', summary: 'Cancelled by user' };
  } }) });
  try {
    await until(() => surface.ready); surface.emit('line', 'Implement a change'); await until(() => running);
    await until(() => surface.model.entries.some(entry => entry.id.endsWith('item:cmd-1')));
    surface.emit('line', '/tasks'); surface.emit('line', '/status'); surface.emit('line', '/help'); surface.emit('line', '/mode detailed'); surface.emit('line', 'Start an overlapping task');
    await until(() => surface.model.entries.some(entry => entry.title.includes('Commands:')) && surface.model.entries.some(entry => entry.title.includes('Work is running')));
    assert.equal(surface.model.mode, 'detailed'); assert.equal(turns, 1);
    const adapter = new TerminalEngineAdapter(repository); const task = (await adapter.list())[0];
    assert.match((await adapter.snapshot(task.id)).activities.find(entry => entry.id.endsWith('item:cmd-1'))!.body!, /Working output/);
    surface.emit('line', '/cancel'); await until(() => !surface.model.context.busy);
    assert.equal((await adapter.list())[0].status, 'cancelled');
    surface.emit('line', '/quit'); assert.equal(await session, 0); assert.ok(surface.destroyed);
    assert.equal(JSON.parse(await readFile(join(repository, '.harness/ui.json'), 'utf8')).mode, 'detailed');
    const next = new Surface(); const second = startTerminal({ repositoryPath: repository }, { surface: next });
    await until(() => next.ready); assert.equal(next.model.mode, 'detailed'); next.close(); await second;
  } finally { surface.close(); await session; await rm(root, { recursive: true, force: true }); if (workspace) await rm(dirname(workspace), { recursive: true, force: true }); }
});
test('workspace selection preserves the launch directory and warns for an empty directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ctx-workspace-'));
  try { const before = process.cwd(); const empty = await inspectWorkspace(root); assert.match(empty.workspaceWarning, /no Git repository/); await writeFile(join(root, 'pyproject.toml'), '[project]'); assert.equal((await inspectWorkspace(root)).workspaceWarning, ''); assert.equal(process.cwd(), before); }
  finally { await rm(root, { recursive: true, force: true }); }
});

test('an environment-blocked UI task starts Codex only after explicit /retry host approval', { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'ctx-retry-')); await writeFile(join(root, 'package.json'), '{"scripts":{"test":"true"}}');
  const surface = new Surface(); let turns = 0; let workspace: string | undefined;
  const session = startTerminal({ repositoryPath: root, execution: 'auto' }, { surface,
    docker: { kind: 'simulated', async command() { return { code: 1, output: 'Cannot connect to the Docker daemon', timedOut: false, truncated: false }; } },
    agent: () => ({ async execute(input) { turns++; workspace = input.workspacePath; return { outcome: 'completed', summary: 'Fixture application task completed' }; } }),
  });
  try {
    await until(() => surface.ready); surface.emit('line', 'Implement a small application feature');
    await until(() => surface.model.entries.some(entry => entry.title.includes('BLOCKED')) && !surface.model.context.busy);
    assert.equal(turns, 0); surface.emit('line', '/retry host');
    await until(() => surface.model.entries.some(entry => entry.title.includes('COMPLETED')) && !surface.model.context.busy);
    assert.equal(turns, 1); const records = await new TerminalEngineAdapter(root).list(); assert.equal(records.length, 2); assert.equal(records[0].environment?.selectedMode, 'host');
    const blockedWorkspace = records[1].workspacePath; if (blockedWorkspace) await rm(dirname(blockedWorkspace), { recursive: true, force: true });
  } finally { surface.close(); await session; await rm(root, { recursive: true, force: true }); if (workspace) await rm(dirname(workspace), { recursive: true, force: true }); }
});
