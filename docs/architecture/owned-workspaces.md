# Owned workspace lifecycle

`OwnedWorkspaces` coordinates the durable `TaskRepository.workspaces` registry with filesystem preparation, archival and cleanup. The registry commits ownership intent and exclusive attempt access before creating directories. Each managed root carries a nonce marker; ready records bind device/inode identities for the root, snapshot and worktree. Arbitrary directories and legacy workspaces are never adopted automatically.

Creation reuses the private source snapshot, preserves dirty/untracked/ignored source files, records a private baseline SHA and task branch `ctx/<safe-task-component>/<attempt>`, and never modifies source Git metadata. Included source symlinks, unsafe Git metadata and source Git locks/in-progress operations block execution. Preparation observes cancellation between copies and Git steps; partial state remains recorded and retained. Private Git operations disable hooks and fsmonitor.

Archival captures a diff against the recorded base (including changes committed by the worker), exact worktree file bytes/modes including ignored/untracked files, the private snapshot file tree, and a Git bundle. Immutable archive receipts bind all three artifact IDs and the worktree and private snapshot hashes, Git references and HEAD. Byte/count/artifact limits refuse oversized archives and retain the worktree. Binary tree packages/bundles preserve exact bytes and explicitly do not claim text redaction or secret scanning.

Cleanup requires a terminal task, no active writer/verifier or live/unknown worker, an intact matching archive, configured retention (default seven days), nonce/path/inode agreement and no unexpected root entries. Worktree/snapshot edits and Git-reference changes after archive refuse cleanup until explicitly archived again. Git removes the owned worktree; only its validated private snapshot is recursively removed. The ownership marker is removed last. Interrupted cleanup can resume, and already removed paths are never deleted if recreated by a human. Partial creation without a complete archive is retained for inspection rather than guessed disposable.

Orphan scanning reports retained resources and refuses unrecorded directories. It does not infer process death from a timeout. Exact APIs and verified phase completion status are in the Phase 05 report; lifecycle tests exercise cancellation, lock conflicts, dirty-content refusal, substituted directories, bundle restore and cleanup interruption.

Configured defaults, sampled-limit semantics and preparation command ownership: [worker runtime](worker-runtime.md).
