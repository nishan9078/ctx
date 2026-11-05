import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from './postgres-client.js';
test('migrates disposable PostgreSQL and reads persisted application data', async () => {
  const db = await connect();
  try {
    await db.query('CREATE TABLE IF NOT EXISTS harness_items (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
    await db.query("INSERT INTO harness_items VALUES (1, 'fixture') ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name");
    assert.deepEqual(await db.query('SELECT name FROM harness_items WHERE id=1'), [['fixture']]);
  } finally { db.close(); }
});
