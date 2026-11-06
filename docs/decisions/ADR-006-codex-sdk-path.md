# ADR-006: Codex SDK is the sole Phase 04 orchestration path

Date: 2026-11-06. Status: accepted for Phase 04.

## Context

The master roadmap (P04-09) asks whether existing app-server code should be retained for rich interactive mode; it must not add a second competing orchestration path. Audit of this repository finds **no app-server orchestration code in CTX**: the only Codex integration is the SDK adapter (`packages/agents/src/codex-sdk.adapter.ts`, `@openai/codex-sdk` 0.166.0) plus the CLI's legacy runner. There is therefore no second path to migrate, and creating one would double the queue, lease, and cancellation semantics.

The installed SDK publicly supports everything Phase 04 requires, verified against its installed type surface (`node_modules/@openai/codex-sdk/dist/index.d.ts`) and process behavior:

- `startThread` / `resumeThread` with thread options (`workingDirectory`, `sandboxMode`, `approvalPolicy`, `networkAccessEnabled`, `webSearchMode`, `model`),
- `Thread.runStreamed` (async generator of newline-delimited JSON events) and `Thread.run`,
- per-turn `signal?: AbortSignal` (passed to the CLI spawn),
- typed items: `agent_message`, `command_execution`, `file_change`, `mcp_tool_call`, `reasoning`, `todo_list`, `web_search`, `error`, plus `thread.started`, `turn.started`, `turn.completed`, `turn.failed`, stream `error`.

## Decision

- **Phase 04 uses the Codex SDK as the sole orchestration path** for both the preserved legacy runner and the new durable queue worker. The queue worker supervises the SDK in an owned subprocess (Feature D) so cancellation can kill the process group; the SDK spawns the codex CLI without `detached`, so group signalling reaches it.
- **Keep the SDK at 0.166.0.** Upgrade only when a demonstrated incompatibility requires a separately documented change (ADR-000 baseline).
- **No App Server orchestration path is added.** Interactive/rich UX stays out of scope for Phase 04; any future interactive mode (P08/P10+) must integrate behind the same canonical `WorkerEvent` vocabulary rather than reinterpreting private event shapes.
- The queue scheduler is never given Codex event shapes: provider payloads are translated at the adapter boundary (Feature C) into canonical `WorkerEvent` values.

## Consequences

- One code path for queue execution, cancellation, and recovery; two process layers (scheduler process → supervised SDK subprocess → codex CLI) share one process-group ownership model.
- When a future phase needs richer interactivity, it must reuse the adapter boundary and canonical events rather than adopt a second protocol for durable queue state.

## Implementation evidence

Phase 04 integration is verified against actual CLI/SDK **0.166.0** on development Node 22.22.1 and bundled Node 26.4.0. `createCodexQueueScheduler` composes the queue worker and independent verification handoff; the scheduler does not inspect provider payloads. Linux process-group ownership includes sequential IPC acknowledgements, child/descendant cleanup and an orphan-host disconnect handler. Explicit resume retains the original workspace and session in a new fenced attempt; crash recovery never automatically replays real effects.

The approved real fixture smoke passed with a complete accepted raw stream, canonical events, session ID, diff and SDK-reported token counters. Monetary cost and actual model/provider identity were unavailable and remain unknown. Ordinary engineering task completion still requires Phase 06 verification; full resource/worktree ownership hardening remains Phase 05. See [Phase 04 evidence](../verification/phase-04/REPORT.md).
