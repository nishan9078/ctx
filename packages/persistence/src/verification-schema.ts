/** Immutable migration 7: owner-defined profiles, frozen attempt gates, exact waivers and evidence statuses. */
export const verificationSchema = `
ALTER TABLE ctx_verification_steps RENAME TO ctx_verification_steps_v6;
ALTER TABLE ctx_verification_runs RENAME TO ctx_verification_runs_v6;
CREATE TABLE ctx_verification_runs (
 id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL REFERENCES ctx_attempts(id), profile TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('passed','passed_with_waivers','failed','unavailable','cancelled','not_run','mock_verified')),
 started_at TEXT NOT NULL, ended_at TEXT,
 report_artifact_id TEXT REFERENCES ctx_artifacts(id), markdown_artifact_id TEXT REFERENCES ctx_artifacts(id),
 profile_hash TEXT, workspace_hash TEXT, metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json))
) STRICT;
INSERT INTO ctx_verification_runs(id,attempt_id,profile,status,started_at,ended_at)
 SELECT id,attempt_id,profile,status,started_at,ended_at FROM ctx_verification_runs_v6;
CREATE TABLE ctx_verification_steps (
 run_id TEXT NOT NULL REFERENCES ctx_verification_runs(id), name TEXT NOT NULL, required INTEGER NOT NULL CHECK(required IN (0,1)),
 status TEXT NOT NULL CHECK(status IN ('passed','failed','unavailable','cancelled','not-applicable','not_applicable','not_run','skipped_with_approval','mock_verified')),
 command TEXT, exit_code INTEGER, stdout_ref TEXT REFERENCES ctx_artifacts(id), stderr_ref TEXT REFERENCES ctx_artifacts(id),
 metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)), PRIMARY KEY(run_id,name)
) STRICT;
INSERT INTO ctx_verification_steps(run_id,name,required,status,command,exit_code,stdout_ref,stderr_ref)
 SELECT run_id,name,required,status,command,exit_code,stdout_ref,stderr_ref FROM ctx_verification_steps_v6;
DROP TABLE ctx_verification_steps_v6;
DROP TABLE ctx_verification_runs_v6;
CREATE TABLE ctx_verification_profiles (
 project_id TEXT NOT NULL REFERENCES ctx_projects(id), profile_id TEXT NOT NULL, hash TEXT NOT NULL,
 definition_json TEXT NOT NULL CHECK(json_valid(definition_json)), owner_id TEXT NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(project_id,profile_id)
) STRICT;
CREATE TABLE ctx_attempt_profiles (
 attempt_id TEXT PRIMARY KEY REFERENCES ctx_attempts(id), task_spec_hash TEXT NOT NULL,
 profile_hash TEXT, definition_json TEXT CHECK(definition_json IS NULL OR json_valid(definition_json)), owner_id TEXT,
 CHECK((profile_hash IS NULL AND definition_json IS NULL AND owner_id IS NULL) OR (profile_hash IS NOT NULL AND definition_json IS NOT NULL AND owner_id IS NOT NULL))
) STRICT;
CREATE TABLE ctx_verification_waivers (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES ctx_tasks(id), task_spec_hash TEXT NOT NULL,
 profile_hash TEXT NOT NULL, step_id TEXT NOT NULL, attempt_sequence INTEGER NOT NULL CHECK(attempt_sequence>=1),
 reason TEXT NOT NULL, approved_by TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL,
 used_by_attempt TEXT REFERENCES ctx_attempts(id), UNIQUE(task_id,attempt_sequence,step_id)
) STRICT;
CREATE TABLE ctx_verification_processes (
 id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL REFERENCES ctx_attempts(id), step_id TEXT NOT NULL,
 pid INTEGER NOT NULL, pgid INTEGER NOT NULL CHECK(pgid=pid), host TEXT NOT NULL, identity TEXT NOT NULL,
 started_at TEXT NOT NULL, ended_at TEXT
) STRICT;
CREATE TRIGGER ctx_profiles_no_update BEFORE UPDATE ON ctx_verification_profiles BEGIN SELECT RAISE(ABORT,'Profiles are immutable; register a new ID'); END;
CREATE TRIGGER ctx_profiles_no_delete BEFORE DELETE ON ctx_verification_profiles BEGIN SELECT RAISE(ABORT,'Profiles are immutable'); END;
CREATE TRIGGER ctx_attempt_profiles_no_update BEFORE UPDATE ON ctx_attempt_profiles BEGIN SELECT RAISE(ABORT,'Attempt gates are immutable'); END;
CREATE TRIGGER ctx_attempt_profiles_no_delete BEFORE DELETE ON ctx_attempt_profiles BEGIN SELECT RAISE(ABORT,'Attempt gates are immutable'); END;
CREATE TRIGGER ctx_waiver_scope_no_update BEFORE UPDATE OF task_id,task_spec_hash,profile_hash,step_id,attempt_sequence,reason,approved_by,expires_at,created_at ON ctx_verification_waivers BEGIN SELECT RAISE(ABORT,'Waiver scope is immutable'); END;
CREATE TRIGGER ctx_waivers_no_delete BEFORE DELETE ON ctx_verification_waivers BEGIN SELECT RAISE(ABORT,'Waivers are immutable'); END;
CREATE TRIGGER ctx_gate_runs_no_update BEFORE UPDATE ON ctx_verification_runs BEGIN SELECT RAISE(ABORT,'Verification reports are immutable'); END;
CREATE TRIGGER ctx_gate_runs_no_delete BEFORE DELETE ON ctx_verification_runs BEGIN SELECT RAISE(ABORT,'Verification reports are immutable'); END;
CREATE TRIGGER ctx_gate_steps_no_update BEFORE UPDATE ON ctx_verification_steps BEGIN SELECT RAISE(ABORT,'Verification steps are immutable'); END;
CREATE TRIGGER ctx_gate_steps_no_delete BEFORE DELETE ON ctx_verification_steps BEGIN SELECT RAISE(ABORT,'Verification steps are immutable'); END;
`;
