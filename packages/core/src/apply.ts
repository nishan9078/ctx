import { access, mkdir, lstat, readFile, writeFile, rename, link, unlink, rmdir, chmod, realpath } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { changedPaths } from '../../environment/src/workspace.js';
import { runProcess } from '../../environment/src/process-manager.js';
import { worktreeMetadata } from '../../environment/src/git-worktree.js';
import { safeRelativePath, type AcceptanceCriterion } from '../../verification/src/policy.js';
import { requiredChecksPass } from '../../verification/src/execute-plan.js';
import { TaskStore } from '../../persistence/src/database.js';
import type { TaskRecord } from './types.js';
type Fingerprint = { kind: 'file'; hash: string; mode: number } | { kind: 'directory' } | null;
export interface ApplyEntry { path: string; before: Fingerprint; after: Fingerprint }
export interface ApplyManifest { version: 1; taskId: string; repository: string; workspace: string; entries: ApplyEntry[] }
export interface ApplyPreview { taskId: string; target: string; entries: ApplyEntry[]; conflicts: string[]; token?: string; expiresAt?: number; note: string }
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
async function atomicJson(path: string, value: unknown): Promise<void> { const temporary = `${path}.${randomUUID()}.tmp`; await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); await rename(temporary, path); }
async function safeParents(root: string, path: string): Promise<void> {
  if (!safeRelativePath(path)) throw new Error(`Unsafe apply path: ${path}`);
  let current = root;
  for (const part of path.split('/').slice(0, -1)) {
    current = join(current, part);
    try { const info = await lstat(current); if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Unsafe apply parent: ${current}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}
async function fingerprint(root: string, path: string): Promise<Fingerprint> {
  await safeParents(root, path);
  try {
    const target = join(root, path); const info = await lstat(target);
    if (info.isSymbolicLink()) throw new Error(`Symbolic link refused: ${path}`);
    if (info.isDirectory()) return { kind: 'directory' };
    if (!info.isFile()) throw new Error(`Special file refused: ${path}`);
    return { kind: 'file', hash: hash(await readFile(target)), mode: info.mode & 0o777 };
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
export async function createApplyManifest(task: Pick<TaskRecord, 'id' | 'repositoryPath' | 'workspacePath'>, criteria: AcceptanceCriterion[], verifiedPaths: string[] = []): Promise<ApplyManifest> {
  await worktreeMetadata(task.workspacePath);
  const baseline = join(dirname(task.workspacePath), 'snapshot'); const changed = await changedPaths(task.workspacePath);
  const paths = new Set([...changed.paths, ...verifiedPaths, ...criteria.filter(item => item.kind !== 'directory').map(item => item.path)]);
  for (const criterion of criteria) if (criterion.kind === 'directory' && !await fingerprint(baseline, criterion.path)) paths.add(criterion.path);
  if (paths.size > 2000) throw new Error('Apply manifest exceeds 2000 changed paths');
  const entries: ApplyEntry[] = [];
  for (const path of [...paths].sort()) {
    const before = await fingerprint(baseline, path); const after = await fingerprint(task.workspacePath, path);
    if (after?.kind === 'directory' && before) continue;
    if (!same(before, after)) entries.push({ path, before, after });
  }
  return { version: 1, taskId: task.id, repository: task.repositoryPath, workspace: task.workspacePath, entries };
}
async function taskAndManifest(database: string, id: string, target: string): Promise<{ task: TaskRecord; manifest: ApplyManifest; manifestHash: string }> {
  const store = new TaskStore(database);
  try {
    const task = store.get(id);
    if (task.status !== 'completed' || task.report?.outcome !== 'completed' || !requiredChecksPass(task.verification)) throw new Error('Apply requires a completed task with independently passing mandatory checks');
    if (await realpath(target) !== await realpath(task.repositoryPath)) throw new Error('Selected target does not match the task repository; apply cannot redirect a task to another project');
    if (!task.applyManifest) throw new Error('This task has no verified apply manifest. Run a new verified task; legacy reports cannot be applied automatically.');
    for (const path of [task.applyManifest, join(task.directory, 'changes.diff'), ...(task.verificationPlan && task.verification.length ? [join(dirname(task.verification[0].artifact), 'verification-plan.json')] : []), ...task.verification.map(check => check.artifact)]) {
      const row = store.db.prepare('SELECT checksum FROM artifacts WHERE task_id=? AND path=?').get(id, path) as { checksum: string } | undefined;
      if (!row || hash(await readFile(path)) !== row.checksum) throw new Error(`Verification/apply evidence missing or changed: ${path}`);
    }
    const bytes = await readFile(task.applyManifest); const manifest = JSON.parse(bytes.toString()) as ApplyManifest;
    if (manifest.version !== 1 || manifest.taskId !== id || manifest.workspace !== task.workspacePath || manifest.repository !== task.repositoryPath || !Array.isArray(manifest.entries)) throw new Error('Invalid apply manifest');
    await worktreeMetadata(task.workspacePath);
    for (const entry of manifest.entries) {
      if (!safeRelativePath(entry.path) || !same(await fingerprint(task.workspacePath, entry.path), entry.after)) throw new Error(`Verified worktree changed after verification: ${entry.path}`);
    }
    return { task, manifest, manifestHash: hash(bytes) };
  } finally { store.close(); }
}
async function conflicts(target: string, manifest: ApplyManifest): Promise<string[]> {
  const result: string[] = [];
  for (const entry of manifest.entries) {
    try { if (!same(await fingerprint(target, entry.path), entry.before)) result.push(`${entry.path}: target differs from the original snapshot (including untracked file collisions)`); }
    catch (error) { result.push(`${entry.path}: ${(error as Error).message}`); }
  }
  const git = await runProcess('git', ['rev-parse', '--is-inside-work-tree'], target);
  if (git.code === 0 && manifest.entries.length) {
    const status = await runProcess('git', ['--literal-pathspecs', '-c', 'core.fsmonitor=false', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching', '--ignore-submodules=all', '--', ...manifest.entries.map(entry => entry.path)], target);
    if (status.code !== 0 || status.truncated) result.push('Could not prove affected Git paths are clean');
    else if (status.output) result.push('Affected paths contain existing staged, unstaged, untracked, or ignored work. Preserve/commit that work before applying; it will not be overwritten.');
  }
  return result;
}
async function metadataDirectory(target: string): Promise<string> {
  const metadata = join(target, '.harness');
  try { const info = await lstat(metadata); if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Target .harness must be an ordinary directory'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await mkdir(metadata, { mode: 0o700 }); }
  return metadata;
}
export async function previewApply(database: string, id: string, target: string): Promise<ApplyPreview> {
  target = await realpath(target); await metadataDirectory(target);
  const { task, manifest, manifestHash } = await taskAndManifest(database, id, target);
  const problems = await conflicts(target, manifest);
  const preview: ApplyPreview = { taskId: id, target, entries: manifest.entries, conflicts: problems,
    note: 'Only the listed verified paths will be transferred. Existing affected Git work is protected. No staging/commit occurs, and no post-apply integration checks are implied. Unrelated target edits can affect integration. Do not edit affected paths during apply; backups and a crash-recovery journal are retained.' };
  if (!problems.length && manifest.entries.length) {
    preview.token = randomUUID(); preview.expiresAt = Date.now() + 15 * 60_000;
    await atomicJson(join(task.directory, 'apply-preview.json'), { ...preview, manifestHash });
  }
  return preview;
}
interface AppliedOperation { entry: ApplyEntry; moved?: boolean; installed?: boolean; createdDirectory?: boolean }
export async function confirmApply(database: string, id: string, target: string, token: string, hooks: { beforeTransfer?: (path: string, index: number) => void | Promise<void> } = {}): Promise<{ status: 'applied'; paths: string[]; receipt: string; backup: string; limitations: string[] }> {
  target = await realpath(target); const metadata = await metadataDirectory(target);
  const { task, manifest, manifestHash } = await taskAndManifest(database, id, target);
  const preview = JSON.parse(await readFile(join(task.directory, 'apply-preview.json'), 'utf8')) as ApplyPreview & { manifestHash: string };
  if (!token || token !== preview.token || preview.target !== target || preview.manifestHash !== manifestHash || !preview.expiresAt || Date.now() > preview.expiresAt) throw new Error('Apply preview expired or changed; request a fresh /apply preview');
  const lockPath = join(metadata, 'apply.lock');
  try { await writeFile(lockPath, JSON.stringify({ taskId: id, pid: process.pid, started: new Date().toISOString() }), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`Apply lock exists at ${lockPath}. Inspect the retained journal/backup before recovering an interrupted apply; no action was replayed.`); throw error; }
  const transaction = join(metadata, `apply-${randomUUID()}`); const journal = join(transaction, 'journal.json');
  const operations: AppliedOperation[] = []; const madeParents: string[] = []; let status = 'preparing'; let recoveryNeeded = false;
  const saveJournal = () => atomicJson(journal, { status, taskId: id, target, operations, madeParents, note: 'Original files remain under original/. Never overwrite concurrent edits during recovery.' });
  try {
    await mkdir(join(transaction, 'original'), { recursive: true, mode: 0o700 }); await mkdir(join(transaction, 'new'), { mode: 0o700 });
    const problems = await conflicts(target, manifest); if (problems.length) throw new Error(`Apply conflict: ${problems.join('\n')}`);
    for (const entry of manifest.entries) if (entry.after?.kind === 'file') {
      const content = await readFile(join(task.workspacePath, entry.path)); if (hash(content) !== entry.after.hash) throw new Error(`Verified file changed: ${entry.path}`);
      const stage = join(transaction, 'new', entry.path); await mkdir(dirname(stage), { recursive: true }); await writeFile(stage, content, { mode: entry.after.mode }); await chmod(stage, entry.after.mode);
    }
    status = 'applying'; await saveJournal();
    async function parents(path: string): Promise<void> {
      let current = target;
      for (const part of path.split('/').slice(0, -1)) {
        current = join(current, part);
        try { const info = await lstat(current); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Apply parent changed'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await mkdir(current, { mode: 0o755 }); madeParents.push(current); await saveJournal(); }
      }
    }
    for (const entry of manifest.entries) {
      await hooks.beforeTransfer?.(entry.path, operations.length);
      await safeParents(target, entry.path);
      if (!same(await fingerprint(target, entry.path), entry.before)) throw new Error(`Apply conflict detected immediately before transfer: ${entry.path}`);
      const operation: AppliedOperation = { entry }; operations.push(operation); await saveJournal();
      const path = join(target, entry.path);
      if (entry.before?.kind === 'directory') throw new Error('Directory replacement/deletion is not supported');
      if (entry.after?.kind === 'directory') { await parents(entry.path); await mkdir(path, { mode: 0o755 }); operation.createdDirectory = true; }
      else {
        await parents(entry.path);
        if (entry.before) {
          const backup = join(transaction, 'original', entry.path); await mkdir(dirname(backup), { recursive: true });
          await rename(path, backup); operation.moved = true; await saveJournal();
          if (!same(await fingerprint(join(transaction, 'original'), entry.path), entry.before)) throw new Error(`Concurrent edit detected; original retained for ${entry.path}`);
        }
        // Hard-link installation fails atomically if another writer creates the
        // target. Unlike rename-overwrite, this never replaces a new collision.
        if (entry.after) { await link(join(transaction, 'new', entry.path), path); operation.installed = true; }
      }
      await saveJournal();
    }
    status = 'applied'; await saveJournal();
    await unlink(join(task.directory, 'apply-preview.json')); // Token is single-use.
    const receipt = join(task.directory, 'apply-receipt.json'); const result = { status: 'applied' as const, paths: manifest.entries.map(entry => entry.path), receipt, backup: transaction, limitations: ['Verification covered the isolated worktree. Post-apply integration/build/browser checks were not run.', 'Original files and a transaction journal were retained. Avoid concurrent editing during apply.'] };
    await atomicJson(receipt, result); return result;
  } catch (error) {
    status = 'rolling-back';
    for (const operation of operations.slice().reverse()) {
      const { entry } = operation; const path = join(target, entry.path);
      try {
        if (operation.installed) {
          const current = await fingerprint(target, entry.path);
          if (current?.kind !== 'file' || entry.after?.kind !== 'file' || current.hash !== entry.after.hash) throw new Error('Concurrent target edit preserved');
          await unlink(path);
        }
        if (operation.createdDirectory) await rmdir(path); // Refuses nonempty concurrent work.
        if (operation.moved) await link(join(transaction, 'original', entry.path), path); // Never overwrite a new file.
      } catch { recoveryNeeded = true; }
    }
    for (const path of madeParents.slice().reverse()) { try { await rmdir(path); } catch {} }
    status = recoveryNeeded ? 'needs-manual-recovery' : 'rolled-back'; await saveJournal();
    throw new Error(`${(error as Error).message}\nApply ${status}. Original data and journal retained at ${transaction}.`);
  } finally { if (!recoveryNeeded) await unlink(lockPath); }
}
