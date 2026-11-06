import { lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { artifactPolicy, type ArtifactManifest } from '../../shared/src/artifacts.js';
import type { CommandActor } from '../../shared/src/domain.js';
import { CtxError, ValidationError } from '../../shared/src/errors.js';
import { identifier } from '../../shared/src/validation.js';
import { redactForDiagnostics } from '../../shared/src/redact.js';
import { ordinaryDirectory, sha256, syncPath, validateArtifactManifest } from './artifact-files.js';
import type { TaskRepository } from './task-repository.js';
export interface ArtifactInput { taskId: string; attemptId?: string; kind: string; retention?: 'log' | 'evidence' }
export class ArtifactStore {
  readonly #env: NodeJS.ProcessEnv;
  private constructor(readonly root: string, env: NodeJS.ProcessEnv) { this.#env = { ...env }; }
  static async open(root: string, env: NodeJS.ProcessEnv = process.env): Promise<ArtifactStore> {
    await ordinaryDirectory(join(resolve(root), 'artifacts'), true);
    if (((await lstat(join(resolve(root), 'artifacts'))).mode & 0o077) !== 0) throw new CtxError('UNAUTHORIZED', 'Artifact directory must be private');
    return new ArtifactStore(resolve(root), env);
  }
  async writeText(input: ArtifactInput, content: string, repository: TaskRepository, actor: CommandActor, hooks: { beforePublish?: (directory: string) => Promise<void> } = {}): Promise<ArtifactManifest> {
    if (typeof content !== 'string') throw new ValidationError('artifact.content', 'expected text');
    if (Buffer.byteLength(content) > artifactPolicy.maxArtifactBytes) throw new CtxError('BUDGET_EXHAUSTED', 'Artifact exceeds the per-file budget');
    return this.publish(input, Buffer.from(redactForDiagnostics(content, this.#env) as string), 'text', repository, actor, hooks);
  }
  async writeBinary(input: ArtifactInput, content: Uint8Array, repository: TaskRepository, actor: CommandActor): Promise<ArtifactManifest> {
    if (!(content instanceof Uint8Array)) throw new ValidationError('artifact.content', 'expected bytes');
    if (content.byteLength > artifactPolicy.maxArtifactBytes) throw new CtxError('BUDGET_EXHAUSTED', 'Artifact exceeds the per-file budget');
    return this.publish(input, Buffer.from(content), 'binary', repository, actor, {});
  }
  private async publish(input: ArtifactInput, bytes: Buffer, format: 'text' | 'binary', repository: TaskRepository, actor: CommandActor, hooks: { beforePublish?: (directory: string) => Promise<void> }): Promise<ArtifactManifest> {
    if (resolve(repository.dataDirectory) !== this.root) throw new CtxError('CONFLICT', 'Artifact store must share the database data directory');
    identifier(input.taskId, 'artifact.taskId'); repository.getTask(input.taskId);
    if (bytes.length > artifactPolicy.maxArtifactBytes) throw new CtxError('BUDGET_EXHAUSTED', 'Artifact exceeds the per-file budget');
    const id = randomUUID(); const manifest = validateArtifactManifest({ ...input, id, schemaVersion: 1, location: `artifacts/${id}/content`, sha256: sha256(bytes), bytes: bytes.length, createdAt: new Date().toISOString(), format, redacted: format === 'text', retention: { class: input.retention ?? 'evidence', days: input.retention === 'log' ? artifactPolicy.logRetentionDays : null } });
    const base = join(this.root, 'artifacts'); await ordinaryDirectory(base);
    const stage = join(base, `.staging-${id}`); await mkdir(stage, { mode: 0o700 });
    let published = false;
    try {
      for (const [name, data] of [['content', bytes], ['manifest.json', Buffer.from(JSON.stringify(manifest) + '\n')]] as const) {
        const file = await open(join(stage, name), 'wx', 0o600); try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
      }
      await syncPath(stage); await hooks.beforePublish?.(stage);
      await rename(stage, join(base, id)); published = true; await syncPath(base); await syncPath(this.root);
      const { schemaVersion: _version, format: _format, redacted: _redacted, retention: _retention, ...record } = manifest;
      await repository.recordArtifact(record, actor);
      return manifest;
    } finally { if (!published) await rm(stage, { recursive: true, force: true }); }
  }
}
