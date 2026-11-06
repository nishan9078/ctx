/** V1 tables coexist with unchanged legacy runner tables; no task is silently requeued/imported. */
export const orchestrationSchema = `
CREATE TABLE ctx_projects (
  id TEXT PRIMARY KEY, canonical_path TEXT NOT NULL UNIQUE,
  policy_id TEXT NOT NULL, test_profile TEXT NOT NULL, created_at TEXT NOT NULL
) STRICT;
CREATE TABLE ctx_tasks (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES ctx_projects(id),
  spec_json TEXT NOT NULL CHECK(json_valid(spec_json)), revision INTEGER NOT NULL CHECK(revision >= 1),
  state TEXT NOT NULL CHECK(state IN ('draft','queued','ready','leased','running','verifying','recovering','waiting_capacity','waiting_dependency','waiting_approval','paused','blocked','completed','failed','cancelled')),
  priority TEXT NOT NULL CHECK(priority IN ('low','normal','high','urgent')),
  next_run_at TEXT, reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE ctx_task_dependencies (
  task_id TEXT NOT NULL REFERENCES ctx_tasks(id), prerequisite_id TEXT NOT NULL REFERENCES ctx_tasks(id),
  kind TEXT NOT NULL DEFAULT 'hard' CHECK(kind = 'hard'),
  PRIMARY KEY(task_id, prerequisite_id), CHECK(task_id <> prerequisite_id)
) STRICT;
CREATE TABLE ctx_attempts (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES ctx_tasks(id),
  sequence INTEGER NOT NULL CHECK(sequence >= 1), task_revision INTEGER NOT NULL CHECK(task_revision >= 1),
  state TEXT NOT NULL CHECK(state IN ('leased','running','verifying','completed','failed','interrupted','cancelled')),
  harness_id TEXT NOT NULL CHECK(harness_id IN ('codex','opencode')), provider_key TEXT NOT NULL, model_id TEXT NOT NULL,
  fencing_token INTEGER NOT NULL CHECK(fencing_token >= 1), started_at TEXT NOT NULL, ended_at TEXT,
  UNIQUE(task_id, sequence), UNIQUE(id, task_id), UNIQUE(id, task_id, fencing_token)
) STRICT;
CREATE UNIQUE INDEX ctx_one_active_attempt ON ctx_attempts(task_id) WHERE state IN ('leased','running','verifying');
CREATE TABLE ctx_leases (
  task_id TEXT PRIMARY KEY REFERENCES ctx_tasks(id), attempt_id TEXT NOT NULL UNIQUE REFERENCES ctx_attempts(id),
  owner_id TEXT NOT NULL, fencing_token INTEGER NOT NULL CHECK(fencing_token >= 1),
  expires_at TEXT NOT NULL, last_heartbeat TEXT NOT NULL,
  FOREIGN KEY(attempt_id, task_id, fencing_token) REFERENCES ctx_attempts(id, task_id, fencing_token)
) STRICT;
CREATE TABLE ctx_harness_sessions (
  attempt_id TEXT PRIMARY KEY REFERENCES ctx_attempts(id), adapter_id TEXT NOT NULL,
  external_session_id TEXT, external_run_id TEXT, version TEXT NOT NULL,
  CHECK(adapter_id IN ('codex','opencode'))
) STRICT;
CREATE TABLE ctx_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT, entity TEXT NOT NULL, entity_id TEXT NOT NULL,
  task_id TEXT REFERENCES ctx_tasks(id), type TEXT NOT NULL, actor TEXT NOT NULL, reason TEXT NOT NULL,
  payload TEXT NOT NULL CHECK(json_valid(payload)), created_at TEXT NOT NULL
) STRICT;
CREATE TRIGGER ctx_events_no_update BEFORE UPDATE ON ctx_events BEGIN SELECT RAISE(ABORT, 'Audit events are immutable'); END;
CREATE TRIGGER ctx_events_no_delete BEFORE DELETE ON ctx_events BEGIN SELECT RAISE(ABORT, 'Audit events are immutable'); END;
CREATE TABLE ctx_outbox (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES ctx_tasks(id),
  destination TEXT NOT NULL CHECK(json_valid(destination)), kind TEXT NOT NULL CHECK(kind IN ('accepted','progress','completed','blocked','approval_requested','capacity_wait')),
  deduplication_key TEXT NOT NULL UNIQUE, payload TEXT NOT NULL CHECK(json_valid(payload)),
  next_attempt_at TEXT NOT NULL, retry_count INTEGER NOT NULL DEFAULT 0 CHECK(retry_count >= 0),
  remote_message_id TEXT, delivered_at TEXT, created_at TEXT NOT NULL
) STRICT;
CREATE TABLE ctx_inbox (
  source TEXT NOT NULL, external_event_id TEXT NOT NULL, payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  task_id TEXT NOT NULL REFERENCES ctx_tasks(id), accepted_at TEXT NOT NULL, PRIMARY KEY(source, external_event_id)
) STRICT;
CREATE TABLE ctx_approvals (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES ctx_tasks(id), task_revision INTEGER NOT NULL CHECK(task_revision >= 1),
  attempt_id TEXT REFERENCES ctx_attempts(id), action TEXT NOT NULL CHECK(action IN ('deployment','destructive_db','external_write','payment','secret_write')), action_hash TEXT NOT NULL CHECK(length(action_hash)=64 AND action_hash NOT GLOB '*[^0-9a-f]*'),
  requested_by TEXT NOT NULL, expires_at TEXT NOT NULL,
  decision TEXT NOT NULL CHECK(decision IN ('pending','approved','rejected','expired')), decided_by TEXT, decided_at TEXT,
  FOREIGN KEY(attempt_id, task_id) REFERENCES ctx_attempts(id, task_id)
) STRICT;
CREATE TABLE ctx_artifacts (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES ctx_tasks(id), attempt_id TEXT REFERENCES ctx_attempts(id),
  kind TEXT NOT NULL, location TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL CHECK(length(sha256)=64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  bytes INTEGER NOT NULL CHECK(bytes >= 0), created_at TEXT NOT NULL,
  UNIQUE(id, task_id, attempt_id), FOREIGN KEY(attempt_id, task_id) REFERENCES ctx_attempts(id, task_id)
) STRICT;
CREATE TABLE ctx_checkpoints (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES ctx_tasks(id), attempt_id TEXT NOT NULL REFERENCES ctx_attempts(id),
  schema_version INTEGER NOT NULL CHECK(schema_version=1), artifact_id TEXT NOT NULL REFERENCES ctx_artifacts(id),
  created_at TEXT NOT NULL,
  FOREIGN KEY(attempt_id, task_id) REFERENCES ctx_attempts(id, task_id),
  FOREIGN KEY(artifact_id, task_id, attempt_id) REFERENCES ctx_artifacts(id, task_id, attempt_id)
) STRICT;
CREATE TABLE ctx_capacity_states (
  provider_key TEXT PRIMARY KEY, state TEXT NOT NULL CHECK(state IN ('available','cooldown','unknown','disabled')),
  retry_at TEXT, observed_at TEXT NOT NULL, source TEXT NOT NULL CHECK(source IN ('provider','probe','operator')),
  confidence TEXT NOT NULL CHECK(confidence IN ('authoritative','observed','estimated'))
) STRICT;
CREATE TABLE ctx_verification_runs (
  id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL REFERENCES ctx_attempts(id), profile TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('passed','failed','unavailable','cancelled','not_run')), started_at TEXT NOT NULL, ended_at TEXT
) STRICT;
CREATE TABLE ctx_verification_steps (
  run_id TEXT NOT NULL REFERENCES ctx_verification_runs(id), name TEXT NOT NULL, required INTEGER NOT NULL CHECK(required IN (0,1)),
  status TEXT NOT NULL CHECK(status IN ('passed','failed','unavailable','cancelled','not-applicable')), command TEXT, exit_code INTEGER, stdout_ref TEXT REFERENCES ctx_artifacts(id), stderr_ref TEXT REFERENCES ctx_artifacts(id),
  PRIMARY KEY(run_id, name)
) STRICT;
CREATE TABLE ctx_scheduler_locks (
  resource_key TEXT PRIMARY KEY, owner_id TEXT NOT NULL, fencing_token INTEGER NOT NULL CHECK(fencing_token >= 1), expires_at TEXT NOT NULL
) STRICT;
CREATE TABLE ctx_settings (key TEXT PRIMARY KEY, validated_value TEXT NOT NULL CHECK(json_valid(validated_value)), updated_at TEXT NOT NULL) STRICT;
CREATE INDEX ctx_tasks_eligibility ON ctx_tasks(state, next_run_at, priority);
CREATE INDEX ctx_events_task ON ctx_events(task_id, sequence);
CREATE INDEX ctx_outbox_due ON ctx_outbox(delivered_at, next_attempt_at);
`;
