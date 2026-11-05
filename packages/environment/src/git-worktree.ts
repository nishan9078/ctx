import { join, dirname } from 'node:path';
import { realpath, readFile } from 'node:fs/promises';
import { runProcess } from './process-manager.js';
// A private snapshot preserves dirty/untracked source files without writing to source Git metadata.
export async function addWorktree(snapshot: string, destination: string): Promise<void> {
  const result = await runProcess('git', ['worktree', 'add', '--detach', destination, 'HEAD'], snapshot);
  if (result.code !== 0) throw new Error(`Git worktree creation failed: ${result.output}`);
}
export async function worktreeMetadata(workspace: string): Promise<string | undefined> {
  const entry = await readFile(join(workspace, '.git'), 'utf8').catch(() => undefined);
  if (!entry?.startsWith('gitdir: ')) return undefined; // Legacy standalone Git workspace.
  const gitdir = entry.slice(8).trim();
  const common = (await readFile(join(gitdir, 'commondir'), 'utf8')).trim();
  const path = await realpath(join(gitdir, common));
  const expected = await realpath(join(dirname(workspace), 'snapshot', '.git'));
  if (path !== expected) throw new Error('Worktree Git metadata points outside the task snapshot');
  return path;
}
