/** Immutable migration 4. Fixture attempts are explicitly distinct from real harnesses. */
export const queueSchema = `
PRAGMA defer_foreign_keys=ON;
CREATE TABLE ctx_attempts_next (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES ctx_tasks(id),
 sequence INTEGER NOT NULL CHECK(sequence >= 1), task_revision INTEGER NOT NULL CHECK(task_revision >= 1),
 state TEXT NOT NULL CHECK(state IN ('leased','running','verifying','completed','failed','interrupted','cancelled')),
 harness_id TEXT NOT NULL CHECK(harness_id IN ('codex','opencode','fixture')), provider_key TEXT NOT NULL, model_id TEXT NOT NULL,
 fencing_token INTEGER NOT NULL CHECK(fencing_token >= 1), started_at TEXT NOT NULL, ended_at TEXT,
 retry_epoch INTEGER NOT NULL DEFAULT 1 CHECK(retry_epoch >= 1),
 UNIQUE(task_id, sequence), UNIQUE(id, task_id), UNIQUE(id, task_id, fencing_token)
) STRICT;
INSERT INTO ctx_attempts_next SELECT *,1 FROM ctx_attempts;
DROP TABLE ctx_attempts;
ALTER TABLE ctx_attempts_next RENAME TO ctx_attempts;
CREATE UNIQUE INDEX ctx_one_active_attempt ON ctx_attempts(task_id) WHERE state IN ('leased','running','verifying');
ALTER TABLE ctx_tasks ADD COLUMN retry_epoch INTEGER NOT NULL DEFAULT 1 CHECK(retry_epoch >= 1);
ALTER TABLE ctx_tasks ADD COLUMN control_intent TEXT CHECK(control_intent IN ('pause','cancel'));
ALTER TABLE ctx_leases ADD COLUMN owner_pid INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ctx_leases ADD COLUMN owner_host TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE ctx_leases ADD COLUMN owner_start TEXT NOT NULL DEFAULT 'unknown';
`;
