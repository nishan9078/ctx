# Back up and restore CTX state

Use a trusted local backup destination. Stop/reconcile workers first: backups reject leases and active V1 attempts. These commands preserve task/database state and registered evidence. Project repositories, worktrees, external credential stores and external services are not copied; this is not a machine image.

```sh
pnpm build
node dist/apps/cli/src/index.js backup /tmp/ctx-backup-001 --database /path/to/ctx-data/state.sqlite
node dist/apps/cli/src/index.js restore /tmp/ctx-backup-001 --output /tmp/ctx-restored-001
```

The installed executable accepts the same `ctx backup` and `ctx restore` arguments. Source filename is explicit. Both destination directories must be absent. Restore reports its usable data directory (`/tmp/ctx-restored-001/data`) and database filename. Keep the original source and backup until restoration has been reviewed; run only the intended instance when daemon support arrives.

The bundle publishes `snapshot/manifest.json` with database, file sizes and SHA-256 inventory. A failed/interrupted operation cannot publish a partially verified `snapshot/` or restored `data/`. An incomplete reserved container may remain; inspect it and retry under a new name. Do not overwrite a user directory to recover automatically.

Restore checks every inventoried file, SQLite integrity/foreign keys/schema history, task/dependency consistency, and both content/manifest hashes bound to artifact audit events. Missing or changed evidence, invalid versions, traversal and symlinks cause failure. Checksums detect corruption/inconsistent changes; they do not authenticate an attacker-controlled replacement archive.

Historical legacy evidence is copied unchanged into `data/legacy/`. `data/restore-info.json` maps original relative paths to their archived locations. Legacy DB rows are preserved, but the legacy runner is blocked from automatically following old absolute worktree paths. Review the preserved records/evidence and explicitly reconcile process ownership/worktrees before enabling legacy execution. V1 managed artifacts relocate with the V1 database and can be read with `TaskRepository.verifyStoredArtifact`.

Artifacts default to redacted text, private files/directories and immutable UUID publication. Binary writes are explicit and do not claim redaction. Limits: 16 MiB/artifact, 256 MiB/task, 512 MiB/database snapshot, 1 GiB/backup, 10,000 backup files. Log retention eligibility is 30 days; evidence has no automatic expiry; orphan staging is retained for review under a 24-hour policy. Scheduled cleanup is P15 work. No registered evidence is deleted by backup, restore or the current artifact APIs.
