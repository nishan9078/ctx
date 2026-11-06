# V1 queue lifecycle API

The new queue is accessed through `TaskRepository.queue`. It is a trusted local service API; authenticated transport and client ownership move to Sentinel in P08. Actor fields provide audit context, not authentication.

| API | Contract |
| --- | --- |
| `configure`, `pauseAll`, `configuration` | Persist bounded global/per-project concurrency and global drain/pause state. |
| `refresh` | Re-evaluate dependencies, deadlines, project identity, fixture capabilities and budgets; propagate dependency failures. |
| `claim` | Atomically allocate an attempt/lease/slot with deterministic priority selection. |
| `start`, `heartbeat` | Require owner/fence/expiry; commit running state before invoking work; return durable control intent on heartbeat. |
| `beginVerification` | Keep the exclusive lease while independent checks/evidence run. |
| `completeFixture` | Finish only the explicitly registered fixture profile with independently checked, immutable result/report artifacts. Real verification finalization is P06 work. |
| `settle`, `stopped` | Record failure/wait/approval or confirmed worker quiescence and release the matching lease transactionally. |
| `controlTask` | Revision-checked pause/cancel/resume/explicit retry. Active cancel remains pending until quiescence. |
| `reconcile` | Expired owner must be confirmed dead; live or unknown ownership cannot be stolen. |
| `status`, `attempts` | Consistent queue counters, next deadline, configuration and durable attempt/fencing history. |

`DurableScheduler.tick()` drives reconciliation/eligibility/claims. `runUntilIdle()` waits for local workers; optionally it waits for persisted deadlines. Its observation timeout is not a worker-death declaration. `shutdown()` forwards abort and awaits actual local promise settlement before returning. Callers must await shutdown before closing the repository.

`FixtureWorker` scripts deterministically sleep, succeed, fail, simulate a capacity deadline or request approval. Scripts are trusted fixture configuration, not task-supplied executable instructions. The receipt path is under `repository.dataDirectory/fixture-work`; independent output/profile validation and artifact verification are required before fixture completion. Keep fixture projects separate from human source directories.

The existing CLI/OpenTUI task runner is preserved and does not implicitly consume this queue. Phase 04 replaces the fixture harness path, P05 owns real process/worktree supervision, P06 supplies real completion evidence, and P08 turns UI/CLI into daemon clients. No daemon or live-harness execution is claimed by these APIs alone.
