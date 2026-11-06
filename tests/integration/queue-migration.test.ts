import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskStore } from '../../packages/persistence/src/database.js';
import { orchestrationSchema } from '../../packages/persistence/src/orchestration-schema.js';
import { openOrchestrationDatabase, currentSchemaVersion } from '../../packages/persistence/src/migrations.js';
import { sha256 } from '../../packages/persistence/src/artifact-files.js';
import { CtxError } from '../../packages/shared/src/errors.js';
import { submissionFixture } from '../fixtures/repository.js';
async function v3(active = false) {
  const root = await mkdtemp(join(tmpdir(), 'ctx-v3-queue-upgrade-')); const filename = join(root, 'state.sqlite'); const legacy = new TaskStore(filename); legacy.close(); const db = new DatabaseSync(filename);
  db.exec(orchestrationSchema); db.exec('CREATE TABLE ctx_schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,sha256 TEXT NOT NULL,applied_at TEXT NOT NULL) STRICT; PRAGMA user_version=3;');
  const at = new Date().toISOString(); db.prepare('INSERT INTO ctx_schema_migrations VALUES(?,?,?,?)').run(3, 'versioned-orchestration', sha256(orchestrationSchema), at);
  db.prepare('INSERT INTO ctx_projects VALUES(?,?,?,?,?)').run('fixture', root, 'safe', 'node-api', at);
  db.prepare('INSERT INTO ctx_tasks(id,project_id,spec_json,revision,state,priority,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run('old', 'fixture', JSON.stringify(submissionFixture('old').spec), 1, active ? 'running' : 'blocked', 'normal', at, at);
  db.prepare('INSERT INTO ctx_attempts VALUES(?,?,?,?,?,?,?,?,?,?,?)').run('old-attempt', 'old', 1, 1, active ? 'running' : 'interrupted', 'codex', 'provider/account', 'model', 1, at, active ? null : at);
  db.prepare('INSERT INTO ctx_artifacts VALUES(?,?,?,?,?,?,?,?)').run('old-artifact', 'old', 'old-attempt', 'historical-metadata', 'old-file', 'a'.repeat(64), 10, at);
  db.prepare('INSERT INTO ctx_checkpoints VALUES(?,?,?,?,?,?)').run('old-checkpoint', 'old', 'old-attempt', 1, 'old-artifact', at);
  db.prepare('INSERT INTO ctx_harness_sessions VALUES(?,?,?,?,?)').run('old-attempt', 'codex', 'old-session', null, 'old-version');
  db.close(); return { root, filename };
}
test('v3-to-v4 rebuild preserves attempt, artifact, checkpoint and session references with FK enforcement enabled', async () => {
  const f = await v3();
  try {
    const opened = await openOrchestrationDatabase(f.filename);
    try {
      assert.equal(opened.migratedFrom, 3); assert.ok(opened.backupPath);
      assert.equal((opened.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, currentSchemaVersion);
      assert.equal((opened.db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys, 1); assert.deepEqual(opened.db.prepare('PRAGMA foreign_key_check').all(), []);
      for (const table of ['ctx_attempts', 'ctx_artifacts', 'ctx_checkpoints', 'ctx_harness_sessions']) assert.equal((opened.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n, 1);
      assert.equal((opened.db.prepare('SELECT harness_id,retry_epoch FROM ctx_attempts').get() as { harness_id: string }).harness_id, 'codex');
      assert.throws(() => opened.db.prepare('INSERT INTO ctx_artifacts VALUES(?,?,?,?,?,?,?,?)').run('invalid', 'missing', null, 'log', 'invalid', 'b'.repeat(64), 1, new Date().toISOString()), /FOREIGN KEY/);
    } finally { opened.db.close(); }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test('active v3 workers and drifted v3 migration history stop upgrade without advancing schema', async () => {
  for (const active of [true, false]) {
    const f = await v3(active);
    try {
      if (!active) { const db = new DatabaseSync(f.filename); db.exec("UPDATE ctx_schema_migrations SET sha256='drifted'"); db.close(); }
      await assert.rejects(openOrchestrationDatabase(f.filename), error => error instanceof CtxError && error.code === 'CONFLICT');
      const db = new DatabaseSync(f.filename); try { assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 3); assert.equal((db.prepare('SELECT COUNT(*) AS n FROM ctx_checkpoints').get() as { n: number }).n, 1); } finally { db.close(); }
    } finally { await rm(f.root, { recursive: true, force: true }); }
  }
});
