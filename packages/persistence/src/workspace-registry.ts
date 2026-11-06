import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { CommandActor, TaskSnapshot } from '../../shared/src/domain.js';
import type { LeaseClaim } from '../../shared/src/scheduling.js';
import type { OwnedWorkspace, WorkspaceIdentity } from '../../shared/src/workspaces.js';
import { CtxError } from '../../shared/src/errors.js';
import { identifier } from '../../shared/src/validation.js';
import { sha256 } from './artifact-files.js';
interface Context {
  db: DatabaseSync; dataDirectory: string; write<T>(work: () => T): T; read<T>(work: () => T): T;
  assertLease(claim: LeaseClaim): void; task(id: string): TaskSnapshot;
  event(id: string, type: string, actor: CommandActor, payload: unknown, taskId: string): void;
}
interface Row { id: string; task_id: string; token: string; state: OwnedWorkspace['state']; identity_json: string; archive_artifact_id: string | null; archive_tree_hash: string | null; created_at: string; updated_at: string }
export class WorkspaceRegistry {
  constructor(private readonly context: Context) {}
  get(id: string): OwnedWorkspace {
    identifier(id, 'workspace.id');
    return this.context.read(() => {
      const row = this.context.db.prepare('SELECT * FROM ctx_workspaces WHERE id=?').get(id) as Row | undefined;
      if (!row) throw new CtxError('NOT_FOUND', 'Owned workspace record is missing; never adopt an unrecorded directory');
      return { id: row.id, ownerAttemptId: row.id, taskId: row.task_id, token: row.token, state: row.state, identity: JSON.parse(row.identity_json), archiveArtifactId: row.archive_artifact_id ?? undefined, archiveTreeHash: row.archive_tree_hash ?? undefined, createdAt: row.created_at, updatedAt: row.updated_at };
    });
  }
  list(): OwnedWorkspace[] { return this.context.read(() => (this.context.db.prepare('SELECT id FROM ctx_workspaces ORDER BY created_at,id').all() as { id: string }[]).map(row => this.get(row.id))); }
  reserve(claim: LeaseClaim, actor: CommandActor): OwnedWorkspace {
    return this.context.write(() => {
      this.context.assertLease(claim);
      const id = claim.attempt.id; const root = join(this.context.dataDirectory, 'codex-work', id); const at = new Date().toISOString();
      const identity: WorkspaceIdentity = { root, snapshot: join(root, 'snapshot'), worktree: join(root, 'worktree') };
      this.context.db.prepare('INSERT INTO ctx_workspaces(id,task_id,token,state,identity_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(id, claim.task.spec.id, randomUUID(), 'creating', JSON.stringify(identity), at, at);
      this.acquireInner(claim, id);
      this.context.event(id, 'workspace.reserved', actor, { identity, specHash: sha256(JSON.stringify(claim.task.spec)) }, claim.task.spec.id);
      return this.get(id);
    });
  }
  private acquireInner(claim: LeaseClaim, id: string): void {
    const workspace = this.get(id);
    if (workspace.taskId !== claim.task.spec.id || ['cleanup', 'removed'].includes(workspace.state) || workspace.state === 'creating' && id !== claim.attempt.id) throw new CtxError('CONFLICT', 'Workspace is unavailable to this task attempt');
    const access = this.context.db.prepare('SELECT attempt_id,fencing_token FROM ctx_workspace_access WHERE workspace_id=?').get(id) as { attempt_id: string; fencing_token: number } | undefined;
    if (access && (access.attempt_id !== claim.attempt.id || access.fencing_token !== claim.fencingToken)) throw new CtxError('CONFLICT', 'Another attempt owns exclusive workspace access');
    this.context.db.prepare('INSERT INTO ctx_workspace_access VALUES(?,?,?) ON CONFLICT(workspace_id) DO NOTHING').run(id, claim.attempt.id, claim.fencingToken);
  }
  acquire(claim: LeaseClaim, id: string, actor: CommandActor): OwnedWorkspace {
    return this.context.write(() => { this.context.assertLease(claim); this.acquireInner(claim, id); this.context.event(id, 'workspace.acquired', actor, { attemptId: claim.attempt.id }, claim.task.spec.id); return this.get(id); });
  }
  ready(claim: LeaseClaim, id: string, identity: WorkspaceIdentity, actor: CommandActor): OwnedWorkspace {
    return this.context.write(() => {
      this.context.assertLease(claim); this.assertAccess(claim, id); const current = this.get(id);
      if (current.state !== 'creating' || id !== claim.attempt.id || current.identity.root !== identity.root || current.identity.snapshot !== identity.snapshot || current.identity.worktree !== identity.worktree || !identity.baseSha || !identity.branch || !identity.device || !identity.inode) throw new CtxError('CONFLICT', 'Invalid workspace preparation identity');
      this.context.db.prepare("UPDATE ctx_workspaces SET state='ready',identity_json=?,updated_at=? WHERE id=?").run(JSON.stringify(identity), new Date().toISOString(), id);
      this.context.event(id, 'workspace.ready', actor, { identity }, current.taskId); return this.get(id);
    });
  }
  assertAccess(claim: LeaseClaim, id: string): void {
    this.context.assertLease(claim);
    const row = this.context.db.prepare('SELECT attempt_id,fencing_token FROM ctx_workspace_access WHERE workspace_id=?').get(id) as { attempt_id: string; fencing_token: number } | undefined;
    if (row?.attempt_id !== claim.attempt.id || row.fencing_token !== claim.fencingToken) throw new CtxError('CONFLICT', 'Attempt has no exclusive workspace access');
  }
  assertQuiescent(id: string): void {
    const workspace = this.get(id);
    if (this.context.db.prepare('SELECT 1 FROM ctx_workspace_access WHERE workspace_id=?').get(id) || this.context.db.prepare("SELECT 1 FROM ctx_attempts WHERE task_id=? AND state IN ('leased','running','verifying')").get(workspace.taskId)) throw new CtxError('CONFLICT', 'Workspace task still has an active writer or verifier');
  }
  archive(id: string, artifactId: string, treeHash: string, actor: CommandActor, claim?: LeaseClaim): OwnedWorkspace {
    return this.context.write(() => {
      if (claim) this.assertAccess(claim, id); else this.assertQuiescent(id);
      const workspace = this.get(id);
      if (!['ready', 'archived'].includes(workspace.state) || !/^[a-f0-9]{64}$/.test(treeHash)) throw new CtxError('CONFLICT', 'Workspace cannot be archived in this state');
      const artifact = this.context.db.prepare('SELECT task_id,attempt_id FROM ctx_artifacts WHERE id=?').get(artifactId) as { task_id: string; attempt_id: string | null } | undefined;
      if (artifact?.task_id !== workspace.taskId || claim && artifact.attempt_id !== claim.attempt.id) throw new CtxError('CONFLICT', 'Archive belongs to a different task or attempt');
      this.context.db.prepare("UPDATE ctx_workspaces SET state='archived',archive_artifact_id=?,archive_tree_hash=?,updated_at=? WHERE id=?").run(artifactId, treeHash, new Date().toISOString(), id);
      this.context.event(id, 'workspace.archived', actor, { artifactId, treeHash }, workspace.taskId); return this.get(id);
    });
  }
  beginCleanup(id: string, actor: CommandActor, retentionMs: number): OwnedWorkspace {
    return this.context.write(() => {
      this.assertQuiescent(id); const workspace = this.get(id); const task = this.context.task(workspace.taskId);
      if (!['completed', 'failed', 'cancelled'].includes(task.state)) throw new CtxError('CONFLICT', 'Cleanup requires a terminal task; blocked work must be preserved');
      if (workspace.state === 'removed') return workspace;
      if (!['archived', 'cleanup'].includes(workspace.state) || !workspace.archiveArtifactId || !workspace.archiveTreeHash || !Number.isFinite(retentionMs) || retentionMs < 0 || Date.now() - Date.parse(workspace.updatedAt) < retentionMs) throw new CtxError('CONFLICT', 'Workspace must be archived and past its retention window');
      this.context.db.prepare("UPDATE ctx_workspaces SET state='cleanup' WHERE id=?").run(id);
      this.context.event(id, 'workspace.cleanup_started', actor, { archiveArtifactId: workspace.archiveArtifactId }, workspace.taskId); return this.get(id);
    });
  }
  removed(id: string, actor: CommandActor): void {
    this.context.write(() => { this.assertQuiescent(id); const workspace = this.get(id); if (workspace.state === 'removed') return;
      if (workspace.state !== 'cleanup') throw new CtxError('CONFLICT', 'Cleanup intent is missing');
      this.context.db.prepare("UPDATE ctx_workspaces SET state='removed',updated_at=? WHERE id=?").run(new Date().toISOString(), id);
      this.context.event(id, 'workspace.removed', actor, {}, workspace.taskId);
    });
  }
}
