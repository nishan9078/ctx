/**
 * Queue-facing execution boundary for Codex runs (P04-02, P04-05).
 *
 * The durable-scheduler glue in packages/core talks to this provider-neutral
 * port. The default implementation supervises the installed Codex SDK in an
 * owned subprocess (packages/core/src/supervised-codex-executor.ts +
 * codex-worker-entry.ts); tests inject a fake executor producing
 * deterministic SDK-event streams without credentials.
 */
export interface CodexProcessInfo {
  pid: number; pgid: number; host: string; identity: string; startedAt: string;
}
export interface CodexRunInput {
  prompt: string;
  workspacePath: string;
  /** Explicitly authorized thread/session to resume; omitted for a fresh run. */
  sessionId?: string;
  model?: string;
  signal: AbortSignal;
  /**
   * Sequential sink for raw SDK events (in child line order). Throwing aborts
   * the run and is surfaced to the caller (lease loss, fence rejection).
   */
  onRawEvent: (event: unknown) => Promise<void>;
  /** Called once after the supervised process exists (for ownership records). */
  onProcess?: (process: CodexProcessInfo) => Promise<void> | void;
}
export interface CodexRunResult {
  sessionId?: string;
  /** Process exit code; null when killed by a signal or still unreaped. */
  exitCode: number | null;
  exitSignal: string | null;
  stderrTail: string;
  stderrTruncated: boolean;
  aborted: boolean;
  spawned: boolean;
}
export interface CodexExecutor {
  run(input: CodexRunInput): Promise<CodexRunResult>;
}
