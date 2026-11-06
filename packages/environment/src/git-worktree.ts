import { join, dirname, relative, isAbsolute, sep } from 'node:path';
import { realpath } from 'node:fs/promises';
import { safeDirectory, safeReadText } from './path-safety.js';
import { runProcess } from './process-manager.js';
// A private snapshot preserves dirty/untracked source files without writing to source Git metadata.
export async function addWorktree(snapshot: string, destination: string, options: { signal?: AbortSignal; branch?: string } = {}): Promise<void> {
  const result = await runProcess('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', 'worktree', 'add', ...(options.branch ? ['-b', options.branch] : ['--detach']), destination, 'HEAD'], snapshot, { signal: options.signal });
  if (result.code !== 0) throw new Error(`Git worktree creation failed: ${result.output}`);
}
export async function worktreeMetadata(workspace: string): Promise<string | undefined> {
  await safeDirectory(workspace);
  let entry: string | undefined;
  try { entry = await safeReadText(join(workspace, '.git')); } catch (error) { if (!['ENOENT', 'EISDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) {
    const { lstat } = await import('node:fs/promises'); const info = await lstat(join(workspace, '.git')); if (!info.isDirectory() || info.isSymbolicLink()) throw error;
  } }
  if (!entry?.startsWith('gitdir: ')) return undefined; // Legacy standalone Git workspace.
  const gitdir = entry.slice(8).trim();
  await safeDirectory(gitdir);
  const expectedGit = await safeDirectory(join(dirname(workspace), 'snapshot', '.git'));
  const local = relative(join(expectedGit, 'worktrees'), gitdir);
  if (!local || local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local) || local.includes(sep)) throw new Error('Git worktree metadata directory is not owned by this snapshot');
  if ((await safeReadText(join(gitdir, 'gitdir'))).trim() !== join(workspace, '.git')) throw new Error('Git worktree reverse identity changed');
  const common = (await safeReadText(join(gitdir, 'commondir'))).trim();
  const path = await realpath(join(gitdir, common));
  const expected = await realpath(join(dirname(workspace), 'snapshot', '.git'));
  if (path !== expected) throw new Error('Worktree Git metadata points outside the task snapshot');
  return path;
}
