import { constants } from 'node:fs';
import { lstat, readdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { CtxError } from '../../shared/src/errors.js';
import { safeDirectory } from './path-safety.js';
export interface TreeEntry { path: string; kind: 'directory' | 'file'; mode: number; sha256?: string; content?: string }
export const treeHash = (entries: TreeEntry[]) => createHash('sha256').update(JSON.stringify(entries.map(({ content: _content, ...entry }) => entry))).digest('hex');
/** Includes ignored/untracked files; excludes only the worktree's administrative .git pointer. */
export async function workspaceTree(root: string, maxBytes = 10 * 1024 * 1024): Promise<{ entries: TreeEntry[]; hash: string }> {
  await safeDirectory(root); const entries: TreeEntry[] = []; let bytes = 0;
  async function visit(path: string, relative: string) {
    for (const name of (await readdir(path)).sort()) {
      if (!relative && name === '.git') continue;
      if (entries.length >= 10000) throw new CtxError('BUDGET_EXHAUSTED', 'Workspace archive exceeds its file-count budget');
      const file = join(path, name); const target = relative ? `${relative}/${name}` : name; const stat = await lstat(file);
      if (stat.isSymbolicLink()) throw new CtxError('UNAUTHORIZED', 'Workspace tree contains a symlink');
      if (stat.isDirectory()) { entries.push({ path: target, kind: 'directory', mode: stat.mode & 0o777 }); await visit(file, target); }
      else if (stat.isFile() && stat.nlink === 1) {
        bytes += stat.size; if (bytes > maxBytes) throw new CtxError('BUDGET_EXHAUSTED', 'Workspace archive exceeds its byte budget; retain worktree');
        const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const observed = await handle.stat(); if (observed.ino !== stat.ino || observed.dev !== stat.dev || observed.size !== stat.size) throw new CtxError('CONFLICT', 'Workspace changed during archive');
          const content = await handle.readFile(); bytes += Math.max(0, content.length - stat.size); if (bytes > maxBytes) throw new CtxError('BUDGET_EXHAUSTED', 'Workspace grew during archive');
          entries.push({ path: target, kind: 'file', mode: stat.mode & 0o777, sha256: createHash('sha256').update(content).digest('hex'), content: content.toString('base64') });
        } finally { await handle.close(); }
      } else throw new CtxError('UNAUTHORIZED', 'Workspace tree contains a special file or external hard link');
    }
  }
  await visit(root, ''); return { entries, hash: treeHash(entries) };
}
