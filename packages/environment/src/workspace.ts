import { cp, mkdir, readdir, lstat, realpath } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { runProcess } from './process-manager.js';
export async function prepareWorkspace(repositoryPath: string, destination: string): Promise<string> {
  const source = await realpath(repositoryPath);
  const target = resolve(destination);
  const rel = relative(source, target);
  if (!rel || (!rel.startsWith('..') && !isAbsolute(rel))) throw new Error('Workspace must be outside source repository');
  await mkdir(target, { recursive: false });
  const excluded = new Set(['.git', 'node_modules', '.harness']);
  async function copyDirectory(from: string, to: string) {
    for (const entry of await readdir(from, { withFileTypes: true })) {
      if (excluded.has(entry.name)) continue;
      const input = join(from, entry.name); const output = join(to, entry.name);
      if ((await lstat(input)).isSymbolicLink()) throw new Error(`Symlinks are not supported in Milestone 1: ${input}`);
      if (entry.isDirectory()) { await mkdir(output); await copyDirectory(input, output); }
      else if (entry.isFile()) await cp(input, output);
    }
  }
  await copyDirectory(source, target);
  for (const args of [ ['init', '-q'], ['add', '-A'], ['-c', 'user.name=Harness', '-c', 'user.email=harness@localhost', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'Harness baseline'] ]) {
    const result = await runProcess('git', args, target);
    if (result.code !== 0) throw new Error(`Workspace initialization failed: ${result.output}`);
  }
  return target;
}
export async function captureDiff(workspacePath: string): Promise<string> {
  // Include new files as well as tracked edits, without modifying the source repo.
  const stage = await runProcess('git', ['add', '-A'], workspacePath);
  if (stage.code !== 0) throw new Error(stage.output);
  const diff = await runProcess('git', ['diff', '--cached', '--binary', 'HEAD'], workspacePath);
  if (diff.code !== 0) throw new Error(diff.output);
  if (diff.truncated) throw new Error('Diff exceeds the 1,000,000 character evidence limit; inspect the retained workspace.');
  return diff.output;
}
