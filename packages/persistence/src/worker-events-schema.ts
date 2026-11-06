/** Immutable migration 5. Durable canonical + redacted diagnostic storage for real harness workers. */
export const workerEventsSchema = `
CREATE TABLE ctx_worker_events (
 attempt_id TEXT NOT NULL REFERENCES ctx_attempts(id),
 sequence INTEGER NOT NULL CHECK(sequence >= 1),
 kind TEXT NOT NULL CHECK(kind IN ('canonical','diagnostic')),
 type TEXT NOT NULL,
 payload TEXT NOT NULL CHECK(json_valid(payload)),
 delivery_id TEXT NOT NULL,
 created_at TEXT NOT NULL,
 PRIMARY KEY(attempt_id, sequence),
 UNIQUE(attempt_id, delivery_id)
) STRICT;
CREATE TABLE ctx_worker_processes (
 attempt_id TEXT PRIMARY KEY REFERENCES ctx_attempts(id),
 pid INTEGER NOT NULL CHECK(pid >= 1),
 pgid INTEGER NOT NULL CHECK(pgid >= 1),
 host TEXT NOT NULL,
 identity TEXT NOT NULL,
 started_at TEXT NOT NULL
) STRICT;
`;
