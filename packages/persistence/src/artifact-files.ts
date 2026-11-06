import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, parse, resolve, sep } from 'node:path';
import { CtxError, ValidationError } from '../../shared/src/errors.js';
import { artifactPolicy, type ArtifactManifest, type ArtifactRecord } from '../../shared/src/artifacts.js';
import { choice, identifier, integer, keys, record, text } from '../../shared/src/validation.js';
import type { DatabaseSync } from 'node:sqlite';

export const sha256 = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
export async function ordinaryDirectory(path: string, create = false): Promise<void> {
  const absolute = resolve(path); let current = parse(absolute).root;
  for (const part of absolute.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    try { const info = await lstat(current); if (!info.isDirectory() || info.isSymbolicLink()) throw new CtxError('UNAUTHORIZED', 'Storage paths must not traverse symlinks or non-directories'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !create) throw error;
      try { await mkdir(current, { mode: 0o700 }); } catch (race) { if ((race as NodeJS.ErrnoException).code !== 'EEXIST') throw race; const info = await lstat(current); if (!info.isDirectory() || info.isSymbolicLink()) throw new CtxError('UNAUTHORIZED', 'Storage path changed during creation'); }
      await syncPath(dirname(current));
    }
  }
}
export async function syncPath(path: string): Promise<void> {
  const handle = await open(path, 'r'); try { await handle.sync(); } finally { await handle.close(); }
}
export async function syncDirectories(root: string): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) if (entry.isDirectory()) await syncDirectories(join(root, entry.name));
  await syncPath(root);
}
export async function readJsonFile(path: string, maximum: number): Promise<unknown> {
  await ordinaryDirectory(dirname(path));
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat(); if (!info.isFile() || info.size > maximum) throw new CtxError('BUDGET_EXHAUSTED', 'JSON file exceeds the storage budget');
    const buffer = Buffer.alloc(info.size + 1); let total = 0;
    while (total < buffer.length) { const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null); if (!bytesRead) break; total += bytesRead; }
    if (total !== info.size) throw new CtxError('CONFLICT', 'JSON file changed during verification');
    try { return JSON.parse(buffer.subarray(0, total).toString('utf8')) as unknown; } catch { throw new ValidationError('manifest', 'invalid JSON'); }
  } finally { await handle.close(); }
}
export function artifactLocation(value: unknown): string {
  const path = text(value, 'artifact.location', 100);
  if (!/^artifacts\/[a-f0-9-]{36}\/content$/.test(path)) throw new ValidationError('artifact.location', 'expected a managed artifact location');
  return path;
}
export function validateArtifact(value: unknown): ArtifactRecord {
  const v = record(value, 'artifact');
  keys(v, ['id', 'taskId', 'attemptId', 'kind', 'location', 'sha256', 'bytes', 'createdAt'], 'artifact');
  const id = identifier(v.id, 'artifact.id'); const location = artifactLocation(v.location);
  if (location !== `artifacts/${id}/content` || typeof v.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(v.sha256)) throw new ValidationError('artifact', 'identity or SHA-256 is invalid');
  const createdAt = text(v.createdAt, 'artifact.createdAt', 30);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(createdAt) || !Number.isFinite(Date.parse(createdAt))) throw new ValidationError('artifact.createdAt', 'expected an ISO timestamp');
  return { id, taskId: identifier(v.taskId, 'artifact.taskId'), ...(v.attemptId === undefined ? {} : { attemptId: identifier(v.attemptId, 'artifact.attemptId') }), kind: identifier(v.kind, 'artifact.kind'), location,
    sha256: v.sha256, bytes: integer(v.bytes, 0, artifactPolicy.maxArtifactBytes, 'artifact.bytes'), createdAt };
}
export function validateArtifactManifest(input: unknown): ArtifactManifest {
  const v = record(input, 'manifest'); keys(v, ['schemaVersion', 'id', 'taskId', 'attemptId', 'kind', 'location', 'sha256', 'bytes', 'createdAt', 'format', 'redacted', 'retention'], 'manifest');
  if (v.schemaVersion !== 1) throw new ValidationError('manifest.schemaVersion', 'only version 1 is supported', 'UNSUPPORTED_SCHEMA');
  const { schemaVersion: _version, format, redacted, retention, ...descriptor } = v;
  const file = validateArtifact(descriptor); const policy = record(retention, 'manifest.retention'); keys(policy, ['class', 'days'], 'manifest.retention');
  const category = choice(policy.class, ['log', 'evidence'], 'manifest.retention.class');
  if (policy.days !== (category === 'log' ? artifactPolicy.logRetentionDays : null)) throw new ValidationError('manifest.retention.days', 'does not match retention policy');
  const encoding = choice(format, ['text', 'binary'], 'manifest.format');
  if (redacted !== (encoding === 'text')) throw new ValidationError('manifest.redacted', 'must truthfully reflect text/binary handling');
  return { ...file, schemaVersion: 1, format: encoding, redacted, retention: { class: category, days: policy.days as number | null } };
}
/** Bounded streaming read/copy; no symlink targets, special files or silent truncation. */
export async function inspectFile(source: string, maximum: number, destination?: string): Promise<{ sha256: string; bytes: number }> {
  await ordinaryDirectory(dirname(source));
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let output: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const info = await input.stat();
    if (!info.isFile() || info.size > maximum) throw new CtxError('BUDGET_EXHAUSTED', 'File is not regular or exceeds the storage budget');
    if (destination) { await ordinaryDirectory(dirname(destination), true); output = await open(destination, 'wx', 0o600); }
    const hash = createHash('sha256'); const buffer = Buffer.alloc(64 * 1024); let total = 0;
    for (;;) {
      const { bytesRead } = await input.read(buffer, 0, buffer.length, null); if (!bytesRead) break;
      total += bytesRead; if (total > maximum) throw new CtxError('BUDGET_EXHAUSTED', 'File grew beyond the storage budget');
      hash.update(buffer.subarray(0, bytesRead));
      if (output) { let written = 0; while (written < bytesRead) { const result = await output.write(buffer, written, bytesRead - written, null); if (!result.bytesWritten) throw new CtxError('INTERNAL', 'Artifact copy made no progress'); written += result.bytesWritten; } }
    }
    if (total !== info.size) throw new CtxError('CONFLICT', 'File changed during storage verification');
    if (output) await output.sync();
    return { sha256: hash.digest('hex'), bytes: total };
  } finally { await input.close(); await output?.close(); }
}
export function recordedManifestHash(db: DatabaseSync, id: string): string {
  const row = db.prepare("SELECT json_extract(payload,'$.manifestSha256') AS hash FROM ctx_events WHERE entity='artifact' AND entity_id=? AND type='artifact.recorded' ORDER BY sequence LIMIT 1").get(id) as { hash: unknown } | undefined;
  if (!row || typeof row.hash !== 'string' || !/^[a-f0-9]{64}$/.test(row.hash)) throw new CtxError('CONFLICT', 'Artifact lacks its immutable manifest hash; reconcile before use');
  return row.hash;
}
export async function verifyArtifact(root: string, descriptor: ArtifactRecord, expectedManifestHash?: string): Promise<ArtifactManifest> {
  const expected = validateArtifact(descriptor); const directory = join(resolve(root), dirname(expected.location));
  const manifestPath = join(directory, 'manifest.json');
  const manifest = validateArtifactManifest(await readJsonFile(manifestPath, 64 * 1024));
  if (expectedManifestHash !== undefined && sha256(JSON.stringify(manifest)) !== expectedManifestHash) throw new CtxError('CONFLICT', 'Artifact manifest failed its immutable audit hash');
  for (const field of ['id', 'taskId', 'attemptId', 'kind', 'location', 'sha256', 'bytes', 'createdAt'] as const) if (manifest[field] !== expected[field]) throw new CtxError('CONFLICT', 'Artifact manifest disagrees with the database');
  const actual = await inspectFile(join(resolve(root), expected.location), artifactPolicy.maxArtifactBytes);
  if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes) throw new CtxError('CONFLICT', 'Artifact content failed SHA-256 verification');
  return manifest;
}
