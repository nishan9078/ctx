import { mkdir, lstat, readFile, readdir, unlink, rmdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CommandActor } from '../../shared/src/domain.js';
import type { LeaseClaim } from '../../shared/src/scheduling.js';
import type { OwnedWorkspace } from '../../shared/src/workspaces.js';
import { integer } from '../../shared/src/validation.js';
import { CtxError } from '../../shared/src/errors.js';
import { safeDirectory, safeReadText, safeRepository } from '../../environment/src/path-safety.js';
import { prepareWorkspace, captureDiff, type WorkspacePreparation } from '../../environment/src/workspace.js';
import { worktreeMetadata } from '../../environment/src/git-worktree.js';
import { workspaceTree } from '../../environment/src/workspace-tree.js';
import { privateGit, privateGitScope, assertPrivateGitSafe } from '../../environment/src/private-git.js';
import type { TaskRepository } from '../../persistence/src/task-repository.js';
import { ordinaryDirectory, sha256, syncPath } from '../../persistence/src/artifact-files.js';
import { ArtifactStore } from '../../persistence/src/artifact-store.js';
import { workerGroupState } from '../../persistence/src/process-identity.js';
interface Archive { schemaVersion: 1; workspaceId: string; treeHash: string; headSha: string; baseSha: string; diffArtifactId: string; treeArtifactId: string; gitArtifactId: string; snapshotTreeArtifactId: string; snapshotTreeHash: string; gitStateHash: string }
const exists = async (path: string) => { try { await lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } };
async function git(workspace: string, args: string[], signal?: AbortSignal): Promise<string> {
  const result = await privateGit(args, workspace, signal);
  if (result.code !== 0 || result.truncated) throw new CtxError('CONFLICT', 'Owned workspace Git operation failed; preserve workspace and inspect locks');
  return result.output.trim();
}
async function gitStateHash(record: OwnedWorkspace): Promise<string> {
  return sha256(JSON.stringify(await Promise.all([git(record.identity.snapshot, ['for-each-ref', '--format=%(refname) %(objectname)']), git(record.identity.snapshot, ['rev-parse', 'HEAD']), git(record.identity.snapshot, ['rev-parse', '--symbolic-full-name', 'HEAD'])])));
}
export class OwnedWorkspaces {
  private readonly retentionMs: number;
  constructor(private readonly repository: TaskRepository, options: { retentionDays?: number } = {}) { this.retentionMs = integer(options.retentionDays ?? 7, 0, 3650, 'worktreeRetentionDays') * 86400000; }
  create(claim: LeaseClaim, actor: CommandActor, options: WorkspacePreparation = {}): Promise<OwnedWorkspace> { return privateGitScope(() => this.createInScope(claim, actor, options)); }
  private async createInScope(claim: LeaseClaim, actor: CommandActor, options: WorkspacePreparation): Promise<OwnedWorkspace> {
    const record = this.repository.workspaces.reserve(claim, actor); const { root, worktree, snapshot } = record.identity;
    await ordinaryDirectory(join(this.repository.dataDirectory, 'codex-work'), true);
    options.signal?.throwIfAborted(); await mkdir(root, { mode: 0o700 });
    const { open } = await import('node:fs/promises'); const marker = await open(join(root, '.ctx-owner.json'), 'wx', 0o600);
    try { await marker.writeFile(JSON.stringify({ id: record.id, token: record.token }) + '\n'); await marker.sync(); } finally { await marker.close(); }
    await syncPath(root); await syncPath(join(root, '..'));
    const branch = `ctx/${claim.task.spec.id.replace(/[^A-Za-z0-9_-]/g, '_')}/${claim.attempt.id}`;
    this.repository.queue.assertProjectRegistered(claim.task.spec.projectId);
    await prepareWorkspace(this.repository.getProject(claim.task.spec.projectId).repositoryPath, worktree, { ...options, branch });
    const baseSha = await git(worktree, ['rev-parse', '--verify', 'HEAD'], options.signal);
    const rootStat = await lstat(root, { bigint: true }); const snapshotStat = await lstat(snapshot, { bigint: true }); const worktreeStat = await lstat(worktree, { bigint: true });
    let sourceSha: string | undefined;
    const source = this.repository.getProject(claim.task.spec.projectId).repositoryPath;
    const sourceHead = await privateGit(['--no-optional-locks', 'rev-parse', '--verify', 'HEAD'], source, options.signal);
    if (sourceHead.code === 0 && /^[a-f0-9]{40,64}$/.test(sourceHead.output.trim())) sourceSha = sourceHead.output.trim();
    return this.repository.workspaces.ready(claim, record.id, { root, snapshot, worktree, branch, baseSha, sourceSha, device: String(rootStat.dev), inode: String(rootStat.ino), snapshotDevice: String(snapshotStat.dev), snapshotInode: String(snapshotStat.ino), worktreeDevice: String(worktreeStat.dev), worktreeInode: String(worktreeStat.ino) }, actor);
  }
  async assertOwned(id: string, partialCleanup = false): Promise<OwnedWorkspace> {
    const record = this.repository.workspaces.get(id); const expected = join(this.repository.dataDirectory, 'codex-work', id);
    if (record.identity.root !== expected || record.identity.snapshot !== join(expected, 'snapshot') || record.identity.worktree !== join(expected, 'worktree')) throw new CtxError('UNAUTHORIZED', 'Workspace path disagrees with its durable ownership');
    await safeDirectory(expected);
    const marker = JSON.parse(await safeReadText(join(expected, '.ctx-owner.json'))) as { id: string; token: string };
    if (marker.id !== id || marker.token !== record.token) throw new CtxError('UNAUTHORIZED', 'Workspace ownership marker changed');
    for (const [path, device, inode] of [[expected, record.identity.device, record.identity.inode], [record.identity.snapshot, record.identity.snapshotDevice, record.identity.snapshotInode], [record.identity.worktree, record.identity.worktreeDevice, record.identity.worktreeInode]]) {
      if (partialCleanup && path !== expected && !await exists(path!)) continue;
      await safeDirectory(path!); const info = await lstat(path!, { bigint: true });
      if (!device || !inode || String(info.dev) !== device || String(info.ino) !== inode) throw new CtxError('UNAUTHORIZED', 'Workspace directory identity changed');
    }
    if (await exists(record.identity.snapshot)) await safeRepository(record.identity.snapshot);
    if (await exists(record.identity.worktree)) {
      await worktreeMetadata(record.identity.worktree);
      await assertPrivateGitSafe(record.identity.worktree);
      if (await git(record.identity.worktree, ['symbolic-ref', '--short', 'HEAD']) !== record.identity.branch) throw new CtxError('CONFLICT', 'Task branch identity changed');
    }
    return record;
  }
  async resume(claim: LeaseClaim, id: string, actor: CommandActor): Promise<OwnedWorkspace> {
    this.repository.workspaces.acquire(claim, id, actor);
    return this.assertOwned(id);
  }
  private assertStopped(id: string): void {
    this.repository.workspaces.assertQuiescent(id);
    const workspace = this.repository.workspaces.get(id);
    for (const attempt of this.repository.queue.attempts(workspace.taskId)) {
      const worker = this.repository.queue.workerProcess(attempt.id);
      if (worker && workerGroupState(worker) !== 'dead') throw new CtxError('CONFLICT', 'Workspace still has a live or unobservable worker');
    }
  }
  archive(id: string, actor: CommandActor, claim?: LeaseClaim): Promise<OwnedWorkspace> { return privateGitScope(() => this.archiveInScope(id, actor, claim)); }
  private async archiveInScope(id: string, actor: CommandActor, claim?: LeaseClaim): Promise<OwnedWorkspace> {
    if (claim) this.repository.workspaces.assertAccess(claim, id); else this.assertStopped(id);
    const record = await this.assertOwned(id); const root = record.identity.worktree;
    const store = await ArtifactStore.open(this.repository.dataDirectory);
    const input = { taskId: record.taskId, ...(claim ? { attemptId: claim.attempt.id } : {}) };
    const gitBefore = await gitStateHash(record);
    const snapshotBefore = await workspaceTree(record.identity.snapshot);
    const before = await workspaceTree(root); const headSha = await git(root, ['rev-parse', 'HEAD']);
    const patch = await captureDiff(root, record.identity.baseSha);
    const diff = await store.writeText({ ...input, kind: 'workspace-diff' }, patch, this.repository, actor);
    const tree = await store.writeBinary({ ...input, kind: 'workspace-tree' }, Buffer.from(JSON.stringify({ schemaVersion: 1, entries: before.entries })), this.repository, actor);
    const snapshotTree = await store.writeBinary({ ...input, kind: 'workspace-snapshot-tree' }, Buffer.from(JSON.stringify({ schemaVersion: 1, entries: snapshotBefore.entries })), this.repository, actor);
    const bundleFile = join(record.identity.snapshot, '.git', `ctx-archive-${randomUUID()}.bundle`);
    let bundle;
    try {
      await git(root, ['bundle', 'create', bundleFile, '--all']);
      if ((await lstat(bundleFile)).size > 16 * 1024 * 1024) throw new CtxError('BUDGET_EXHAUSTED', 'Git bundle exceeds the artifact budget; retain worktree');
      bundle = await store.writeBinary({ ...input, kind: 'workspace-git-bundle' }, await readFile(bundleFile), this.repository, actor);
    } finally { await unlink(bundleFile).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
    const after = await workspaceTree(root);
    if (gitBefore !== await gitStateHash(record) || snapshotBefore.hash !== (await workspaceTree(record.identity.snapshot)).hash || before.hash !== after.hash || headSha !== await git(root, ['rev-parse', 'HEAD'])) throw new CtxError('CONFLICT', 'Worktree changed while archival was running');
    const receipt: Archive = { schemaVersion: 1, workspaceId: id, treeHash: after.hash, headSha, baseSha: record.identity.baseSha!, diffArtifactId: diff.id, treeArtifactId: tree.id, gitArtifactId: bundle.id, snapshotTreeArtifactId: snapshotTree.id, snapshotTreeHash: snapshotBefore.hash, gitStateHash: gitBefore };
    const archive = await store.writeText({ ...input, kind: 'workspace-archive' }, JSON.stringify(receipt), this.repository, actor);
    return this.repository.workspaces.archive(id, archive.id, after.hash, actor, claim);
  }
  cleanup(id: string, actor: CommandActor, options: { retentionMs?: number; onStage?: (stage: string) => void | Promise<void> } = {}): Promise<void> { return privateGitScope(() => this.cleanupInScope(id, actor, options)); }
  private async cleanupInScope(id: string, actor: CommandActor, options: { retentionMs?: number; onStage?: (stage: string) => void | Promise<void> }): Promise<void> {
    this.assertStopped(id);
    const initial = this.repository.workspaces.get(id); if (initial.state === 'removed') { if (await exists(initial.identity.root)) throw new CtxError('UNAUTHORIZED', 'Removed workspace path was recreated; never delete it'); return; }
    if (!initial.archiveArtifactId) throw new CtxError('CONFLICT', 'Workspace has no archive');
    const descriptor = await this.repository.verifyStoredArtifact(initial.archiveArtifactId);
    const receipt = JSON.parse(await readFile(join(this.repository.dataDirectory, descriptor.location), 'utf8')) as Archive;
    if (!receipt.gitStateHash || !receipt.snapshotTreeArtifactId || !receipt.snapshotTreeHash || descriptor.taskId !== initial.taskId || receipt.workspaceId !== id || receipt.treeHash !== initial.archiveTreeHash) throw new CtxError('CONFLICT', 'Archive identity does not match workspace');
    for (const artifactId of [receipt.diffArtifactId, receipt.treeArtifactId, receipt.gitArtifactId, receipt.snapshotTreeArtifactId]) { const artifact = await this.repository.verifyStoredArtifact(artifactId); if (artifact.taskId !== initial.taskId) throw new CtxError('CONFLICT', 'Archive package contains foreign evidence'); }
    const record = initial;
    if (await exists(record.identity.root)) {
      if (record.state === 'cleanup' && !await exists(join(record.identity.root, '.ctx-owner.json'))) {
        const stat = await lstat(record.identity.root, { bigint: true });
        await safeDirectory(record.identity.root);
        if (String(stat.dev) !== record.identity.device || String(stat.ino) !== record.identity.inode || (await readdir(record.identity.root)).length) throw new CtxError('UNAUTHORIZED', 'Markerless cleanup root is not safely empty');
        await rmdir(record.identity.root); this.repository.workspaces.removed(id, actor); return;
      }
      await this.assertOwned(id, record.state === 'cleanup');
      if (await exists(record.identity.snapshot) && (await workspaceTree(record.identity.snapshot)).hash !== receipt.snapshotTreeHash) throw new CtxError('CONFLICT', 'Unarchived snapshot changes must be preserved');
      if (await exists(record.identity.snapshot) && await gitStateHash(record) !== receipt.gitStateHash) throw new CtxError('CONFLICT', 'Unarchived Git references must be preserved');
      const names = await readdir(record.identity.root);
      if (names.some(name => !['.ctx-owner.json', 'snapshot', 'worktree'].includes(name))) throw new CtxError('UNAUTHORIZED', 'Workspace root contains an unowned entry');
      if (await exists(record.identity.worktree)) {
        if ((await workspaceTree(record.identity.worktree)).hash !== receipt.treeHash || await git(record.identity.worktree, ['rev-parse', 'HEAD']) !== receipt.headSha) throw new CtxError('CONFLICT', 'Unarchived dirty changes must be preserved');
        this.repository.workspaces.beginCleanup(id, actor, options.retentionMs ?? this.retentionMs);
        await git(record.identity.snapshot, ['worktree', 'remove', '--force', record.identity.worktree]);
        await options.onStage?.('worktree-removed');
      }
      this.repository.workspaces.beginCleanup(id, actor, options.retentionMs ?? this.retentionMs);
      if (await exists(record.identity.snapshot)) { await safeDirectory(record.identity.snapshot); await rm(record.identity.snapshot, { recursive: true }); }
      await unlink(join(record.identity.root, '.ctx-owner.json')); await rmdir(record.identity.root); await syncPath(join(record.identity.root, '..'));
    }
    if (record.state !== 'cleanup') this.repository.workspaces.beginCleanup(id, actor, options.retentionMs ?? this.retentionMs);
    this.repository.workspaces.removed(id, actor);
  }
  async reconcileOrphans(actor: CommandActor, options: { cleanup?: boolean; retentionMs?: number } = {}): Promise<{ id: string; status: string }[]> {
    this.repository.queue.reconcile(actor);
    const entries = await this.scan();
    if (!options.cleanup) return entries;
    for (const entry of entries) {
      if (entry.status !== 'retained-orphan') continue;
      try { await this.cleanup(entry.id, actor, { retentionMs: options.retentionMs }); entry.status = 'removed'; }
      catch (error) { if (!(error instanceof CtxError)) throw error; entry.status = 'retained-refused'; }
    }
    return entries;
  }
  async scan(): Promise<{ id: string; status: string }[]> {
    const result: { id: string; status: string }[] = [];
    for (const record of this.repository.workspaces.list()) {
      try {
        this.assertStopped(record.id);
        if (record.state === 'removed') result.push({ id: record.id, status: await exists(record.identity.root) ? 'unowned-refused' : 'removed' });
        else if (record.state === 'creating') result.push({ id: record.id, status: 'incomplete-retained' });
        else { await this.assertOwned(record.id, record.state === 'cleanup'); result.push({ id: record.id, status: 'retained-orphan' }); }
      }
      catch { result.push({ id: record.id, status: 'active-or-uncertain' }); }
    }
    const parent = join(this.repository.dataDirectory, 'codex-work');
    if (await exists(parent)) { await safeDirectory(parent); const recorded = new Set(this.repository.workspaces.list().map(item => item.id)); for (const name of await readdir(parent)) if (!recorded.has(name)) result.push({ id: name, status: 'unowned-refused' }); }
    return result;
  }
}
