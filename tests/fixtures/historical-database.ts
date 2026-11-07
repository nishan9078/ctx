import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { migrations } from '../../packages/persistence/src/migrations.js';
/** Execute the actual immutable historical SQL, never emulate an old version by relabeling a new schema. */
export function historicalDatabase(filename: string, version: number): DatabaseSync {
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE; CREATE TABLE ctx_schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,sha256 TEXT NOT NULL,applied_at TEXT NOT NULL) STRICT;');
  for (const step of migrations.filter(step => step.version <= version)) {
    db.exec(step.sql); db.prepare('INSERT INTO ctx_schema_migrations VALUES(?,?,?,?)').run(step.version, step.name, createHash('sha256').update(step.sql).digest('hex'), new Date().toISOString()); db.exec(`PRAGMA user_version=${step.version}`);
  }
  db.exec('PRAGMA defer_foreign_keys=OFF; COMMIT;'); return db;
}
export function copyHistoricalFixture(source: string, target: DatabaseSync, tables: string[]): void {
  target.prepare('ATTACH DATABASE ? AS fixture_source').run(source);
  target.exec('BEGIN IMMEDIATE');
  try {
    for (const table of tables) {
      if (!/^[a-z_]+$/.test(table)) throw new Error('Invalid fixture table');
      const columns = (target.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(column => column.name).join(',');
      target.exec(`INSERT INTO ${table}(${columns}) SELECT ${columns} FROM fixture_source.${table}`);
    }
    target.exec('COMMIT');
  } catch (error) { target.exec('ROLLBACK'); throw error; }
  finally { target.exec('DETACH DATABASE fixture_source'); }
}
