import { DatabaseSync, backup } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, open } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { schema } from './schema.js';
import { orchestrationSchema } from './orchestration-schema.js';
import { CtxError } from '../../shared/src/errors.js';

export interface Migration { version: number; name: string; sql: string }
export const migrations: readonly Migration[] = [
  { version: 2, name: 'legacy-runner-v2', sql: schema.replace(/^PRAGMA .*;$/gm, '') + "\nALTER TABLE resources ADD COLUMN status TEXT NOT NULL DEFAULT 'ready';\nALTER TABLE resources ADD COLUMN data TEXT NOT NULL DEFAULT '{}';" },
  { version: 3, name: 'versioned-orchestration', sql: orchestrationSchema },
];
export const currentSchemaVersion = 3;
const checksum = (migration: Migration) => createHash('sha256').update(migration.sql).digest('hex');
const versionOf = (db: DatabaseSync) => (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
export interface OpenDatabaseResult { db: DatabaseSync; migratedFrom: number; backupPath?: string }

/** Open/migrate at startup before starting workers. Never auto-import legacy tasks into the V1 queue. */
export async function openOrchestrationDatabase(filename: string, steps: readonly Migration[] = migrations): Promise<OpenDatabaseResult> {
  if (filename === ':memory:') throw new CtxError('INVALID_INPUT', 'Durable storage requires a filesystem database path');
  const path = resolve(filename);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let existing = false;
  try { const info = await lstat(path); existing = true; if (!info.isFile() || info.isSymbolicLink()) throw new CtxError('INVALID_INPUT', 'Database must be a regular file'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (!steps.length || steps.at(-1)!.version !== currentSchemaVersion || steps.some((step, i) => !Number.isSafeInteger(step.version) || step.version < 1 || i > 0 && step.version <= steps[i - 1].version)) throw new CtxError('INVALID_INPUT', 'Migration versions must increase to the current schema version');
  const db = new DatabaseSync(path);
  let transaction = false;
  try {
    await chmod(path, 0o600);
    db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;');
    const from = versionOf(db);
    if (from > currentSchemaVersion) throw new CtxError('UNSUPPORTED_SCHEMA', 'Database schema is newer than this CTX build');
    if ((db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check !== 'ok') throw new CtxError('CONFLICT', 'Database integrity check failed; preserve the file for recovery');
    if (from === currentSchemaVersion) {
      verifyMigrationHistory(db, steps);
      return { db, migratedFrom: from };
    }
    db.exec('BEGIN IMMEDIATE'); transaction = true;
    // A competing migrator may have committed while BEGIN waited. Re-read under the write lock.
    const lockedVersion = versionOf(db);
    if (lockedVersion === currentSchemaVersion) {
      verifyMigrationHistory(db, steps); db.exec('COMMIT'); transaction = false;
      return { db, migratedFrom: lockedVersion };
    }
    if (lockedVersion !== from) throw new CtxError('CONFLICT', 'Database version changed during migration; reopen before proceeding');
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map(row => row.name);
    if (from === 0 && tables.length) throw new CtxError('UNSUPPORTED_SCHEMA', 'Unversioned nonempty database requires explicit recovery');
    if (tables.includes('leases')) {
      const count = db.prepare('SELECT COUNT(*) AS count FROM leases').get() as { count: number };
      if (count.count) throw new CtxError('CONFLICT', 'Legacy worker leases exist; stop and reconcile workers before migration');
    }
    let backupPath: string | undefined;
    if (existing || from > 0) {
      // This connection holds the writer lock. A separate read connection snapshots all committed
      // pages (including WAL) while no other writer can commit between backup and schema change.
      const parent = join(dirname(path), 'migration-backups'); await mkdir(parent, { recursive: true, mode: 0o700 });
      const info = await lstat(parent);
      if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw new CtxError('UNAUTHORIZED', 'Migration backup directory must be private and must not be a symlink');
      const directory = await mkdtemp(join(parent, `v${from}-v${currentSchemaVersion}-`));
      backupPath = join(directory, 'state.sqlite');
      const reader = new DatabaseSync(path, { readOnly: true });
      try { await backup(reader, backupPath); } finally { reader.close(); }
      await chmod(backupPath, 0o600);
      const snapshot = new DatabaseSync(backupPath, { readOnly: true });
      try { if (versionOf(snapshot) !== from || (snapshot.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check !== 'ok') throw new CtxError('CONFLICT', 'Pre-migration backup validation failed'); }
      finally { snapshot.close(); }
      for (const entry of [backupPath, directory, parent]) {
        const handle = await open(entry, 'r');
        try { await handle.sync(); } finally { await handle.close(); }
      }
    }
    db.exec('CREATE TABLE IF NOT EXISTS ctx_schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, sha256 TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT;');
    for (const step of steps.filter(item => item.version > from)) {
      // Migration SQL is trusted source code; its transaction/version are controlled here.
      db.exec(step.sql);
      if (!db.isTransaction) throw new CtxError('CONFLICT', 'Migration unexpectedly ended its transaction');
      db.prepare('INSERT INTO ctx_schema_migrations VALUES(?,?,?,?)').run(step.version, step.name, checksum(step), new Date().toISOString());
      db.exec(`PRAGMA user_version=${step.version}`);
    }
    if ((db.prepare('PRAGMA foreign_key_check').all()).length) throw new CtxError('CONFLICT', 'Foreign-key validation failed after migration');
    db.exec('COMMIT'); transaction = false;
    return { db, migratedFrom: from, backupPath };
  } catch (error) {
    if (transaction) { try { db.exec('ROLLBACK'); } catch { /* Preserve the original error. */ } }
    db.close(); throw error;
  }
}
function verifyMigrationHistory(db: DatabaseSync, steps: readonly Migration[]): void {
  const rows = db.prepare('SELECT version,name,sha256 FROM ctx_schema_migrations').all() as { version: number; name: string; sha256: string }[];
  if (!rows.some(row => row.version === currentSchemaVersion)) throw new CtxError('CONFLICT', 'Current schema lacks migration history');
  for (const row of rows) {
    const step = steps.find(item => item.version === row.version);
    if (!step || row.name !== step.name || row.sha256 !== checksum(step)) throw new CtxError('CONFLICT', 'Applied migration differs from this build; do not modify historical migrations');
  }
}
