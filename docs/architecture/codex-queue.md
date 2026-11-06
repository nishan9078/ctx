# Durable Codex queue integration (Phase 04)

The preserved CLI/OpenTUI single-task runner remains available. The V1 queue integration is a local API, not a daemon or automatic legacy task importer.

After registering an approved ordinary project and submitting a delegated task through `TaskRepository`, use the composition function in `packages/core/src/codex-queue-worker.ts`:

```ts
const scheduler = createCodexQueueScheduler(repository, {
  // model: an explicitly configured model; omitted means existing Codex configuration
});
try {
  const status = await scheduler.runUntilIdle({ timeoutMs: 60_000 });
} finally {
  await scheduler.shutdown();
}
```

The observation deadline does not terminate managed work; shutdown cooperatively interrupts and awaits quiescence. The task's persisted wall-time budget still applies. An unresponsive/unobservable owned group retains its capacity rather than being assumed dead.

## Execution and evidence

The worker probes the installed CLI/SDK and credential presence. Presence is not proof of usable authentication; actual execution establishes that. Defaults remain workspace-write, approval never, network disabled, web search disabled, and the existing configured model. No App Server path is added.

Each fresh attempt owns `data/codex-work/<attempt>/snapshot` and a separate `worktree`, prepared through the existing source-copy/private-Git baseline. Dirty/untracked source content is preserved; the registered source checkout is not edited. Workspace identity and the exact task hash are published as immutable attempt artifacts.

The public SDK runs in a detached Linux process group through an IPC host. One raw event is acknowledged only after its immutable raw-log segment, session update, and normalized records are durable. Canonical events and diagnostic rows share an attempt-local sequence; canonical payload sequences match their database rows. Identical delivery IDs replay idempotently; conflicting content and stale fences fail. Command output, task packets, process results, diffs and summaries use the existing bounded/redacted artifact store. The raw event limit is 10,000; normal artifact/task budgets also apply. Canonical payloads are bounded projections; raw artifacts retain complete accepted events, subject to configured redaction and budgets.

The SDK receives an abort signal first; the supervisor escalates to group SIGTERM/SIGKILL, including descendants after leader exit. On supervisor disconnect, the SDK host schedules termination of its own group. Recovery additionally checks recorded worker identity/group state before releasing a dead scheduler's lease. Foreign, unknown or live workers retain capacity.

## Outcomes and verification

A message or end of stream is not success. Completion requires a valid terminal turn and successful process exit, with no malformed/failure stream state. Tool command success checks exit code, not merely a completed process status. Known usage counters are retained without fabricating billing, model/provider identity or missing counters.

`WorkerOutcome.success` can carry `artifactIds`. `DurableScheduler` now accepts an injected `AttemptFinalizer`; its scheduling and lease logic never consumes Codex events. The default fixture pipeline preserves existing independently verified fixture completion. The Codex composition verifies artifact identity/integrity and hands off to required engineering verification: the **attempt** is completed, while the **task** becomes blocked with an explicit reason and a `not_run` verification record. Full engineering completion gates are Phase 06 work.

Missing auth/CLI blocks with a structured failure event. An explicit rate limit before observable tool activity persists a capacity delay. Transient process resource exhaustion before launch permits bounded queue retry. Transport loss, malformed/truncated streams, and abnormal exits preserve evidence and block for reconciliation. Cancellation waits for quiescence and settles the task as cancelled. No permission request is automatically granted.

## Explicit resume and fresh retry

Resume is opt-in through `{ resume: { taskId, attemptId } }` when constructing the Codex scheduler after the owner revision-checks a retry. It requires a quiescent prior Codex attempt, recorded session, matching immutable workspace manifest and unchanged task specification. Resume creates a new fenced attempt using the original retained workspace; its workspace ownership reference is preserved for subsequent explicit resumes. It does not automatically re-run crashed side effects. A normal explicit retry without `resume` prepares a fresh workspace and keeps prior evidence.

Linux process groups are the verified platform. Processes deliberately escaping the owned group and complete resource/Git ownership hardening belong to Phase 05. Diagnostics provide best-effort known-secret redaction; this is not a secret-scanner claim.

## Tests

Deterministic integration uses the installed SDK against a controlled executable, alongside direct stream normalizer tests. No credentials are needed for ordinary tests.

Opt in to one real provider generation against a disposable approved fixture:

```sh
pnpm build
HARNESS_CODEX_QUEUE_LIVE=1 node --test --test-reporter=tap dist/tests/integration/codex-queue-live.test.js
```

It uses existing authentication/configuration, one attempt and a two-minute wall budget. Evidence is retained under `.harness/phase04-live/<run>/`. The ordinary suite skips this smoke test. See the Phase 04 report for the demonstrated live result and current limitations.
