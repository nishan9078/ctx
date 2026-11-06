export type WorkspaceState = 'creating' | 'ready' | 'archived' | 'cleanup' | 'removed';
export interface WorkspaceIdentity {
  root: string; worktree: string; snapshot: string;
  device?: string; inode?: string;
  baseSha?: string; sourceSha?: string; branch?: string;
}
export interface OwnedWorkspace {
  id: string; taskId: string; ownerAttemptId: string; token: string; state: WorkspaceState;
  identity: WorkspaceIdentity; archiveArtifactId?: string; archiveTreeHash?: string;
  createdAt: string; updatedAt: string;
}
