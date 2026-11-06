import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { resolve, parse, join } from 'node:path';
import { CtxError } from '../../shared/src/errors.js';
/** Canonical directories only. Reject symlinked ancestors before any managed write. */
export async function safeDirectory(path: string): Promise<string> {
  const absolute = resolve(path); let current = parse(absolute).root;
  for (const component of absolute.slice(current.length).split('/').filter(Boolean)) {
    current = join(current, component); const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new CtxError('UNAUTHORIZED', 'Directory path traverses a symlink or non-directory');
  }
  if (await realpath(absolute) !== absolute) throw new CtxError('UNAUTHORIZED', 'Directory is not canonical');
  return absolute;
}
export async function safeReadText(path: string, maximum = 4096): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const stat = await handle.stat(); if (!stat.isFile() || stat.size > maximum) throw new CtxError('UNAUTHORIZED', 'Unsafe or oversized metadata file'); return await handle.readFile('utf8'); }
  finally { await handle.close(); }
}

export async function safeRepository(path: string): Promise<string> {
  const root = await safeDirectory(path);
  let metadata: string;
  try {
    const git = await lstat(join(root, '.git'));
    if (git.isSymbolicLink()) throw new CtxError('UNAUTHORIZED', 'Source Git metadata is a symlink');
    if (git.isDirectory()) metadata = join(root, '.git');
    else { const value = await safeReadText(join(root, '.git')); if (!value.startsWith('gitdir: ')) throw new CtxError('UNAUTHORIZED', 'Invalid source Git metadata'); metadata = resolve(root, value.slice(8).trim()); }
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return root; throw error; }
  await safeDirectory(metadata);
  for (const marker of ['index.lock', 'HEAD.lock', 'config.lock', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REBASE_HEAD', 'rebase-merge', 'rebase-apply']) {
    try { await lstat(join(metadata, marker)); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    throw new CtxError('CONFLICT', 'Source Git repository is locked or has an unfinished operation');
  }
  return root;
}
