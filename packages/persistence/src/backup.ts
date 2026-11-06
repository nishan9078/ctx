import { DatabaseSync, backup } from 'node:sqlite';
import { chmod, lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { artifactPolicy, type ArtifactRecord } from '../../shared/src/artifacts.js';
import { CtxError, ValidationError } from '../../shared/src/errors.js';
import { identifier, integer, keys, list, parseTaskSpec, record, relativePath, text } from '../../shared/src/validation.js';
import { inspectFile, ordinaryDirectory, readJsonFile, recordedManifestHash, syncDirectories, syncPath, validateArtifact, verifyArtifact } from './artifact-files.js';
import { currentSchemaVersion, verifyMigrationHistory } from './migrations.js';

interface BundleFile { path: string; sha256: string; bytes: number; kind: 'database' | 'artifact' | 'manifest' | 'legacy'; legacyRelativePath?: string }
interface BackupManifest { schemaVersion: 1; databaseName: string; databaseVersion: number; createdAt: string; files: BundleFile[]; legacyArchivedIds: string[] }
const hasTable = (db: DatabaseSync, name: string): boolean => !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
const version = (db: DatabaseSync): number => (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
function databaseName(value: unknown): string { return identifier(value, 'backup.databaseName'); }
function checkDatabase(db: DatabaseSync): void {
  if (![2, 3, currentSchemaVersion].includes(version(db))) throw new CtxError('UNSUPPORTED_SCHEMA', 'Backup requires a known database schema');
  if ((db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length) throw new CtxError('CONFLICT', 'Database integrity or foreign-key validation failed');
  if (version(db) >= 3) verifyMigrationHistory(db, undefined, version(db));
  if (hasTable(db, 'ctx_tasks')) {
    if (db.prepare('SELECT id FROM ctx_tasks WHERE length(spec_json)>1000000 LIMIT 1').get()) throw new CtxError('CONFLICT', 'Stored task specification exceeds the schema budget');
    const tasks = db.prepare('SELECT id,project_id,spec_json,priority FROM ctx_tasks LIMIT ?').all(artifactPolicy.maxBackupFiles + 1) as { id: string; project_id: string; spec_json: string; priority: string }[];
    if (tasks.length > artifactPolicy.maxBackupFiles) throw new CtxError('BUDGET_EXHAUSTED', 'Backup exceeds the task-count budget');
    for (const task of tasks) {
      const spec = parseTaskSpec(task.spec_json);
      const dependencies = (db.prepare('SELECT prerequisite_id FROM ctx_task_dependencies WHERE task_id=? ORDER BY prerequisite_id').all(task.id) as { prerequisite_id: string }[]).map(row => row.prerequisite_id);
      if (spec.id !== task.id || spec.projectId !== task.project_id || spec.priority !== task.priority || JSON.stringify([...spec.dependsOn].sort()) !== JSON.stringify(dependencies)) throw new CtxError('CONFLICT', 'Stored task specification and dependencies disagree');
    }
  }
}
function managedArtifacts(db: DatabaseSync): ArtifactRecord[] {
  if (!hasTable(db, 'ctx_artifacts')) return [];
  const rows = db.prepare('SELECT * FROM ctx_artifacts LIMIT ?').all(artifactPolicy.maxBackupFiles + 1) as { id: string; task_id: string; attempt_id: string | null; kind: string; location: string; sha256: string; bytes: number; created_at: string }[];
  if (rows.length > artifactPolicy.maxBackupFiles) throw new CtxError('BUDGET_EXHAUSTED', 'Backup exceeds the file-count budget');
  return rows.map(row => validateArtifact({ id: row.id, taskId: row.task_id, ...(row.attempt_id === null ? {} : { attemptId: row.attempt_id }), kind: row.kind, location: row.location, sha256: row.sha256, bytes: row.bytes, createdAt: row.created_at }));
}
function legacyEvidence(db: DatabaseSync): { ids: string[]; files: { path: string; relative: string; sha256: string }[] } {
  if (!hasTable(db, 'tasks')) return { ids: [], files: [] };
  const tasks = db.prepare('SELECT id,data FROM tasks LIMIT ?').all(artifactPolicy.maxBackupFiles + 1) as { id: string; data: string }[];
  if (tasks.length > artifactPolicy.maxBackupFiles) throw new CtxError('BUDGET_EXHAUSTED', 'Legacy archive exceeds the task-count budget');
  const directories = new Map(tasks.map(task => {
    identifier(task.id, 'legacy.taskId'); const value = record(JSON.parse(task.data) as unknown, 'legacy.task');
    const directory = text(value.directory, 'legacy.directory', 4096);
    if (!directory.startsWith('/') || basename(directory) !== task.id || resolve(directory) !== directory) throw new CtxError('CONFLICT', 'Legacy task evidence directory cannot be safely archived');
    return [task.id, directory];
  }));
  const rows = db.prepare('SELECT task_id,path,checksum FROM artifacts ORDER BY task_id,path LIMIT ?').all(artifactPolicy.maxBackupFiles + 1) as { task_id: string; path: string; checksum: string }[];
  if (rows.length > artifactPolicy.maxBackupFiles) throw new CtxError('BUDGET_EXHAUSTED', 'Legacy evidence exceeds the file-count budget');
  return { ids: [...directories.keys()], files: rows.map(row => {
    const directory = directories.get(row.task_id); if (!directory) throw new CtxError('CONFLICT', 'Legacy artifact has no task');
    const path = relativePath(relative(directory, row.path), 'legacy.artifactPath');
    if (typeof row.checksum !== 'string' || !/^[a-f0-9]{64}$/.test(row.checksum)) throw new CtxError('CONFLICT', 'Legacy artifact checksum is invalid');
    return { path: row.path, relative: `${row.task_id}/${path}`, sha256: row.checksum };
  }) };
}
function validateManifest(input: unknown): BackupManifest {
  const value = record(input, 'backup'); keys(value, ['schemaVersion', 'databaseName', 'databaseVersion', 'createdAt', 'files', 'legacyArchivedIds'], 'backup');
  if (value.schemaVersion !== 1) throw new ValidationError('backup.schemaVersion', 'only version 1 is supported', 'UNSUPPORTED_SCHEMA');
  if (!Array.isArray(value.files) || !value.files.length || value.files.length > artifactPolicy.maxBackupFiles) throw new ValidationError('backup.files', 'invalid file count');
  const files: BundleFile[] = Array.from(value.files, entry => {
    const file = record(entry, 'backup.file'); keys(file, ['path', 'sha256', 'bytes', 'kind', 'legacyRelativePath'], 'backup.file');
    const path = relativePath(file.path, 'backup.file.path');
    if (typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256) || !['database', 'artifact', 'manifest', 'legacy'].includes(String(file.kind))) throw new ValidationError('backup.file', 'invalid hash or kind');
    return { path, sha256: file.sha256, bytes: integer(file.bytes, 0, artifactPolicy.maxBackupBytes, 'backup.file.bytes'), kind: file.kind as BundleFile['kind'], ...(file.legacyRelativePath === undefined ? {} : { legacyRelativePath: relativePath(file.legacyRelativePath, 'backup.file.legacyRelativePath') }) };
  });
  const name = databaseName(value.databaseName);
  if (![2, 3, currentSchemaVersion].includes(value.databaseVersion as number)) throw new ValidationError('backup.databaseVersion', 'unsupported database version');
  if (new Set(files.map(file => file.path)).size !== files.length || files.reduce((sum, file) => sum + file.bytes, 0) > artifactPolicy.maxBackupBytes) throw new CtxError('BUDGET_EXHAUSTED', 'Backup contains duplicate paths or exceeds the byte budget');
  if (files.filter(file => file.kind === 'database').length !== 1 || !files.some(file => file.kind === 'database' && file.path === `database/${name}`)) throw new ValidationError('backup.files', 'expected exactly one database snapshot');
  for (const file of files) {
    const correct = file.kind === 'database' ? file.path === `database/${name}` : file.kind === 'legacy' ? /^legacy\/[0-9]+\/content$/.test(file.path) && !!file.legacyRelativePath : (file.kind === 'artifact' ? /^artifacts\/[a-f0-9-]{36}\/content$/.test(file.path) : /^artifacts\/[a-f0-9-]{36}\/manifest\.json$/.test(file.path)) && file.legacyRelativePath === undefined;
    if (!correct) throw new ValidationError('backup.file.path', 'does not match its storage namespace');
  }
  return { schemaVersion: 1, databaseName: name, databaseVersion: value.databaseVersion as number, createdAt: text(value.createdAt, 'backup.createdAt', 40), files, legacyArchivedIds: list(value.legacyArchivedIds, 'backup.legacyArchivedIds', 0, artifactPolicy.maxBackupFiles).map(id => identifier(id, 'backup.legacyArchivedId')) };
}
async function writeJson(path: string, value: unknown): Promise<void> {
  const handle = await open(path, 'wx', 0o600); try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync(); } finally { await handle.close(); }
}
/** Destination is exclusively reserved; only the final snapshot/data rename publishes a result. */
async function reserve(directory: string): Promise<string> {
  const target = resolve(directory); await ordinaryDirectory(dirname(target));
  await mkdir(target, { mode: 0o700 }); const stage = join(target, '.staging'); await mkdir(stage, { mode: 0o700 }); return stage;
}
async function verifyBundleData(root: string, manifest: BackupManifest, restored = false): Promise<void> {
  const db = new DatabaseSync(join(root, restored ? manifest.databaseName : `database/${manifest.databaseName}`), { readOnly: true });
  try {
    checkDatabase(db); if (version(db) !== manifest.databaseVersion) throw new CtxError('CONFLICT', 'Backup schema version disagrees with its manifest');
    const expected = new Set([`database/${manifest.databaseName}`]);
    for (const artifact of managedArtifacts(db)) {
      await verifyArtifact(root, artifact, recordedManifestHash(db, artifact.id)); expected.add(artifact.location); expected.add(join(dirname(artifact.location), 'manifest.json'));
      const content = manifest.files.find(file => file.path === artifact.location);
      if (!content || content.kind !== 'artifact' || content.sha256 !== artifact.sha256 || content.bytes !== artifact.bytes) throw new CtxError('CONFLICT', 'Database artifact is missing or changed in the backup');
    }
    const legacy = legacyEvidence(db);
    if (JSON.stringify([...legacy.ids].sort()) !== JSON.stringify([...manifest.legacyArchivedIds].sort())) throw new CtxError('CONFLICT', 'Legacy task archive does not match the database');
    for (const artifact of legacy.files) {
      const entry = manifest.files.find(file => file.kind === 'legacy' && file.legacyRelativePath === artifact.relative);
      if (!entry || entry.sha256 !== artifact.sha256) throw new CtxError('CONFLICT', 'Legacy evidence is missing or changed in the backup'); expected.add(entry.path);
    }
    if (expected.size !== manifest.files.length || manifest.files.some(file => !expected.has(file.path))) throw new CtxError('CONFLICT', 'Backup file inventory disagrees with database references');
  } finally { db.close(); }
}
export async function createBackup(filename: string, destination: string): Promise<{ directory: string; manifest: BackupManifest }> {
  const source = resolve(filename); await ordinaryDirectory(dirname(source));
  const info = await lstat(source); if (!info.isFile() || info.isSymbolicLink()) throw new CtxError('UNAUTHORIZED', 'Backup source must be a regular database file');
  const name = databaseName(basename(source)); const root = dirname(source); const db = new DatabaseSync(source); let locked = false; let stage: string | undefined;
  try {
    db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;'); locked = true; checkDatabase(db);
    for (const table of ['leases', 'ctx_leases']) if (hasTable(db, table) && (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n) throw new CtxError('CONFLICT', 'Stop and reconcile workers before backup');
    if (hasTable(db, 'ctx_attempts') && db.prepare("SELECT id FROM ctx_attempts WHERE state IN ('leased','running','verifying') LIMIT 1").get()) throw new CtxError('CONFLICT', 'Active attempts must be reconciled before backup');
    const pages = (db.prepare('PRAGMA page_count').get() as { page_count: number }).page_count; const pageSize = (db.prepare('PRAGMA page_size').get() as { page_size: number }).page_size;
    if (pages * pageSize > artifactPolicy.maxDatabaseBytes) throw new CtxError('BUDGET_EXHAUSTED', 'Database exceeds the backup budget');
    stage = await reserve(destination); await ordinaryDirectory(join(stage, 'database'), true);
    const reader = new DatabaseSync(source, { readOnly: true });
    try { await backup(reader, join(stage, 'database', name)); } finally { reader.close(); }
    await chmod(join(stage, 'database', name), 0o600);
    const files: BundleFile[] = [{ path: `database/${name}`, kind: 'database', ...await inspectFile(join(stage, 'database', name), artifactPolicy.maxDatabaseBytes) }];
    const copy = async (path: string, location: string, kind: BundleFile['kind'], expected?: string, legacyRelativePath?: string) => {
      const result = await inspectFile(path, artifactPolicy.maxArtifactBytes, join(stage!, location));
      if (expected && result.sha256 !== expected) throw new CtxError('CONFLICT', 'Source artifact checksum failed; backup was not published');
      files.push({ path: location, kind, ...result, ...(legacyRelativePath ? { legacyRelativePath } : {}) });
      if (files.length > artifactPolicy.maxBackupFiles || files.reduce((sum, file) => sum + file.bytes, 0) > artifactPolicy.maxBackupBytes) throw new CtxError('BUDGET_EXHAUSTED', 'Backup exceeds storage limits');
    };
    for (const artifact of managedArtifacts(db)) {
      await verifyArtifact(root, artifact, recordedManifestHash(db, artifact.id));
      await copy(join(root, artifact.location), artifact.location, 'artifact', artifact.sha256);
      const path = join(dirname(artifact.location), 'manifest.json'); await copy(join(root, path), path, 'manifest');
    }
    const legacy = legacyEvidence(db);
    for (const [index, artifact] of legacy.files.entries()) {
      // Legacy paths are read only within this DB's task evidence directory, never arbitrary paths.
      const taskId = artifact.relative.split('/')[0]; if (relative(join(root, taskId), artifact.path) !== artifact.relative.slice(taskId.length + 1)) throw new CtxError('UNAUTHORIZED', 'Legacy evidence points outside the database data directory');
      await copy(artifact.path, `legacy/${index}/content`, 'legacy', artifact.sha256, artifact.relative);
    }
    const manifest = validateManifest({ schemaVersion: 1, databaseName: name, databaseVersion: version(db), createdAt: new Date().toISOString(), files, legacyArchivedIds: legacy.ids });
    await verifyBundleData(stage, manifest); await writeJson(join(stage, 'manifest.json'), manifest); await syncDirectories(stage);
    await rename(stage, join(resolve(destination), 'snapshot')); stage = undefined; await syncPath(resolve(destination)); await syncPath(dirname(resolve(destination)));
    db.exec('COMMIT'); locked = false;
    return { directory: resolve(destination), manifest };
  } finally { if (locked) { try { db.exec('ROLLBACK'); } catch { /* Preserve the original failure. */ } } db.close(); if (stage) await rm(stage, { recursive: true, force: true }); }
}
export async function restoreBackup(directory: string, destination: string): Promise<{ directory: string; database: string; legacyArchived: number }> {
  const snapshot = join(resolve(directory), 'snapshot'); await ordinaryDirectory(snapshot);
  const manifest = validateManifest(await readJsonFile(join(snapshot, 'manifest.json'), 8 * 1024 * 1024));
  let stage: string | undefined;
  try {
    stage = await reserve(destination);
    for (const file of manifest.files) {
      const target = file.kind === 'database' ? manifest.databaseName : file.path;
      const actual = await inspectFile(join(snapshot, file.path), file.kind === 'database' ? artifactPolicy.maxDatabaseBytes : artifactPolicy.maxArtifactBytes, join(stage, target));
      if (actual.bytes !== file.bytes || actual.sha256 !== file.sha256) throw new CtxError('CONFLICT', 'Backup file failed SHA-256 verification; restore was not published');
    }
    await verifyBundleData(stage, manifest, true);
    await writeJson(join(stage, 'restore-info.json'), { schemaVersion: 1, restoredAt: new Date().toISOString(), legacyArchivedIds: manifest.legacyArchivedIds,
      legacyEvidence: manifest.files.filter(file => file.kind === 'legacy').map(file => ({ originalRelativePath: file.legacyRelativePath, location: file.path })),
      note: 'Legacy paths/worktrees are historical; reconcile explicitly before using the legacy runner. V1 managed artifacts relocate with this database.' });
    await syncDirectories(stage); const target = join(resolve(destination), 'data'); await rename(stage, target); stage = undefined;
    await syncPath(resolve(destination)); await syncPath(dirname(resolve(destination)));
    return { directory: target, database: join(target, manifest.databaseName), legacyArchived: manifest.legacyArchivedIds.length };
  } finally { if (stage) await rm(stage, { recursive: true, force: true }); }
}
