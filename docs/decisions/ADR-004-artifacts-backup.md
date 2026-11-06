# ADR-004: Immutable artifacts and verified relocatable backups

Date: 2026-11-06. Status: accepted for Phase 02.

## Artifact publication

V1 evidence lives beside its database under `artifacts/<uuid>/content` and `manifest.json`. Locations are relative and namespace-validated. Write private temporary files, sync files/directories, then rename the complete staging directory into its final UUID. Only afterward register the descriptor and audit event in one SQLite transaction. Registration rechecks content SHA-256, bytes, ownership and manifest metadata. The immutable audit event binds the canonical manifest SHA-256, including retention, format and redaction declarations. `verifyStoredArtifact` and backup/restore check both hashes.

A failed write cleans its own staging area. A process kill may leave an ignored `.staging-*` directory; failed DB registration may leave an unreferenced final directory. Neither publishes a dangling DB reference or a successful artifact acknowledgement. Backups include registered evidence only.

Text is redacted for known environment credentials, common API key patterns and URL userinfo before hashing/writing. Binary artifacts preserve exact bytes and declare `redacted: false`. This hygiene cannot detect every unknown secret or replace scanning. Credentials remain outside task/artifact content.

## Policy defaults

`shared/src/artifacts.ts` sets 16 MiB per artifact, 256 MiB per task, 512 MiB per database snapshot, 1 GiB per backup and 10,000 backup files. Log manifests carry 30-day retention eligibility, orphan staging a 24-hour review period, and evidence no automatic expiry. P02 enforces admission/backup budgets and sets retention policy; scheduled archival/pruning and daemon-wide disk management belong to P15. Referenced evidence is never automatically deleted by these APIs.

## Snapshot and restore

Owner commands are `ctx backup <new-directory> --database <sqlite-file>` and `ctx restore <backup-directory> --output <new-directory>`. These are local maintenance commands. Both destinations must be new; existing user directories/files are never replaced.

Backup holds the source writer lock, checks integrity/schema/history and refuses leases or active V1 attempts. SQLite's backup API captures committed WAL data through a separate reader. Every referenced managed content/manifest and legacy artifact is copied and hash-checked, then inventoried. Files/nested directories are synced before a final rename publishes `snapshot/` inside the private reserved container. Incomplete containers have no usable snapshot; retry with a new destination.

Restore bounds/validates the inventory, rejects traversal/symlink/special-file paths, copies inventoried files into private staging, rechecks database integrity/foreign keys/history/task identity/dependencies and every content/manifest hash, then publishes `data/`. The returned database path identifies the restored store. Source projects, worktrees and external services are not copied or executed.

Checksums prove consistency, not authenticity against replacement of the entire archive/database. Use trusted owner backups. Restore never silently starts workers.

## Legacy compatibility

Schema-v2/v3 databases are supported. Historical artifact files are accepted only within the source DB's per-task evidence directories, copied byte-for-byte into `legacy/`, and indexed by original relative path in `restore-info.json`. Legacy JSON/database rows stay unchanged. Their absolute worktree/resource paths may still refer to the source instance.

Restored legacy tasks are archived for explicit reconciliation. `TaskStore` refuses automatic reuse when recovery metadata lists legacy tasks; malformed, oversized or symlink recovery markers fail closed. V1 tasks/relative artifacts remain usable through the V1 repository. Historical evidence is preserved without launching an old attempt or writing to an old worktree. Worktree/process reconciliation and portable checkpoint resumption remain later lifecycle work.
