import { cp, mkdir, readdir, lstat, realpath, access, readFile, appendFile } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { addWorktree, worktreeMetadata } from './git-worktree.js';
import { runProcess } from './process-manager.js';
export async function prepareWorkspace(repositoryPath: string, destination: string): Promise<string> {
  const source = await realpath(repositoryPath);
  const target = resolve(destination);
  const rel = relative(source, target);
  if (!rel || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) throw new Error('Workspace must be outside source repository');
  const snapshot = join(target, '..', 'snapshot');
  await mkdir(snapshot, { recursive: false });
  const excluded = new Set(['.git', 'node_modules', '.harness']);
  async function copyDirectory(from: string, to: string) {
    for (const entry of await readdir(from, { withFileTypes: true })) {
      if (excluded.has(entry.name)) continue;
      const input = join(from, entry.name); const output = join(to, entry.name);
      if ((await lstat(input)).isSymbolicLink()) throw new Error(`Symlinks are not supported: ${input}`);
      if (entry.isDirectory()) { await mkdir(output, { recursive: true }); await copyDirectory(input, output); }
      else if (entry.isFile()) await cp(input, output);
    }
  }
  await copyDirectory(source, snapshot);
  const git = async (args: string[]) => {
    const result = await runProcess('git', args, snapshot);
    if (result.code !== 0) throw new Error(`Workspace initialization failed: ${result.output}`);
  };
  await git(['init', '-q']); await git(['add', '-A']);
  // A tracked file may now match .gitignore; retain that tracked status in the private baseline.
  const original = await runProcess('git', ['ls-files', '-z', '--cached'], source);
  if (original.code === 0) {
    if (original.truncated) throw new Error('Source file list exceeds the safe snapshot limit');
    const tracked: string[] = [];
    for (const path of original.output.split('\0').filter(Boolean)) {
      if (path.split('/').some(part => excluded.has(part))) continue;
      try { await access(join(snapshot, path)); tracked.push(path); } catch { /* Preserve source deletions. */ }
    }
    for (let offset = 0; offset < tracked.length; offset += 100) await git(['add', '-f', '--', ...tracked.slice(offset, offset + 100)]);
  }
  await git(['-c', 'user.name=Harness', '-c', 'user.email=harness@localhost', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'Harness baseline']);
  await addWorktree(snapshot, target);
  // Preserve ignored development files (for example .env) without tracking them.
  await copyDirectory(snapshot, target);
  return target;
}
export async function captureDiff(workspacePath: string): Promise<string> {
  // Keep generated dependencies/task metadata out of the private Git index.
  // This edits only the task's private Git metadata, never the selected project.
  const common = await worktreeMetadata(workspacePath);
  const metadata = common ?? join(workspacePath, '.git');
  if (!common) { const info = await lstat(metadata); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe standalone Git metadata'); }
  const exclude = join(metadata, 'info', 'exclude');
  const rules = await readFile(exclude, 'utf8').catch(() => '');
  if (!rules.includes('# CTX generated state')) await appendFile(exclude, '\n# CTX generated state\nnode_modules/\n.harness/\n');
  const reset = await runProcess('git', ['reset', '-q', 'HEAD'], workspacePath);
  if (reset.code !== 0) throw new Error(reset.output);
  // Include new files as well as tracked edits, without modifying the source repo.
  const stage = await runProcess('git', ['add', '-A'], workspacePath);
  if (stage.code !== 0) throw new Error(stage.output);
  const diff = await runProcess('git', ['diff', '--cached', '--binary', 'HEAD'], workspacePath);
  if (diff.code !== 0) throw new Error(diff.output);
  if (diff.truncated) throw new Error('Diff exceeds the 1,000,000 character evidence limit; inspect the retained workspace.');
  return diff.output;
}

export async function changedPaths(workspace: string): Promise<{ paths: string[]; deleted: string[] }> {
  const result = await runProcess('git', ['diff', '--cached', '--name-status', '--no-renames', '-z', 'HEAD'], workspace);
  if (result.code !== 0 || result.truncated) throw new Error(`Cannot enumerate changed files: ${result.output}`);
  const parts = result.output.split('\0').filter(Boolean); const paths: string[] = []; const deleted: string[] = [];
  for (let index = 0; index < parts.length; index += 2) { if (!parts[index + 1]) throw new Error('Malformed changed-file list'); paths.push(parts[index + 1]); if (parts[index] === 'D') deleted.push(parts[index + 1]); }
  return { paths, deleted };
}
