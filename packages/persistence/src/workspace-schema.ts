/** Immutable migration 6: registered inode identities and exclusive durable workspace ownership. */
export const workspaceSchema = `
CREATE TABLE ctx_project_identities (
 project_id TEXT PRIMARY KEY REFERENCES ctx_projects(id), device TEXT NOT NULL, inode TEXT NOT NULL
) STRICT;
CREATE TABLE ctx_workspaces (
 id TEXT PRIMARY KEY REFERENCES ctx_attempts(id), task_id TEXT NOT NULL REFERENCES ctx_tasks(id),
 token TEXT NOT NULL UNIQUE, state TEXT NOT NULL CHECK(state IN ('creating','ready','archived','cleanup','removed')),
 identity_json TEXT NOT NULL CHECK(json_valid(identity_json)),
 archive_artifact_id TEXT REFERENCES ctx_artifacts(id), archive_tree_hash TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE ctx_workspace_access (
 workspace_id TEXT PRIMARY KEY REFERENCES ctx_workspaces(id), attempt_id TEXT NOT NULL UNIQUE REFERENCES ctx_attempts(id),
 fencing_token INTEGER NOT NULL CHECK(fencing_token >= 1)
) STRICT;
`;
