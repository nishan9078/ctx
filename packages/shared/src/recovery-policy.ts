import { verificationHash } from './verification-profile.js';
export const failureClasses = ['verification','security','approval','auth','capacity','network','crash','missing_file','install','environment','budget','unknown'] as const;
export type FailureClass = typeof failureClasses[number];
export interface RecoveryPolicy { maxRepairs: number; perErrorCap: number; repeatCap: number; baseDelayMs: number; maxDelayMs: number; maxElapsedMs: number; maxTokens: number; maxCostUsd?: number }
export function recoveryPolicy(input: Partial<RecoveryPolicy> = {}): RecoveryPolicy {
  const policy = { maxRepairs: 2, perErrorCap: 2, repeatCap: 2, baseDelayMs: 1000, maxDelayMs: 60000, maxElapsedMs: 3600000, maxTokens: 100000, ...input };
  for (const [key, value] of Object.entries(policy)) if (!Number.isFinite(value) || value < 0 || key !== 'maxCostUsd' && !Number.isSafeInteger(value)) throw new Error(`Invalid recovery budget: ${key}`);
  if (!policy.perErrorCap || !policy.repeatCap || policy.maxRepairs > 10 || policy.maxDelayMs > 86400000 || policy.baseDelayMs > policy.maxDelayMs) throw new Error('Invalid recovery bounds');
  return policy;
}
export function classifyFailure(code?: string, log = ''): { kind: FailureClass; source: 'structured' | 'heuristic' | 'unknown' } {
  const codes: Record<string, FailureClass> = { TEST_FAILED:'verification', BUILD_FAILED:'verification', SECURITY_FAILED:'security', UNAUTHORIZED:'approval', APPROVAL_REQUIRED:'approval', AUTH_REQUIRED:'auth', RATE_LIMIT:'capacity', ETIMEDOUT:'network', ECONNRESET:'network', PROCESS_CRASH:'crash', ENOENT:'missing_file', INSTALL_FAILED:'install', ENVIRONMENT_UNAVAILABLE:'environment', BUDGET_EXHAUSTED:'budget' };
  if (code) return { kind: codes[code] ?? 'unknown', source: 'structured' };
  const bounded = log.slice(-4000);
  for (const [pattern, kind] of [[/\b(?:ETIMEDOUT|ECONNRESET)\b/,'network'],[/\bENOENT\b/,'missing_file'],[/\b(?:SIGSEGV|SIGKILL)\b/,'crash'],[/\bnpm ERR!\b/,'install']] as const) if (pattern.test(bounded)) return { kind, source:'heuristic' };
  return { kind:'unknown', source:'unknown' };
}
export function failureFingerprint(kind: FailureClass, failures: unknown): string { return verificationHash({ kind, failures }); }
export function retryDelay(policy: RecoveryPolicy, ordinal: number, random = Math.random()): number {
  if (!Number.isSafeInteger(ordinal) || ordinal < 1 || random < 0 || random > 1 || !Number.isFinite(random)) throw new Error('Invalid retry jitter');
  return Math.floor(Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.min(ordinal - 1, 30)) * (0.5 + random * 0.5));
}
export function recoveryDecision(policy: RecoveryPolicy, input: { kind: FailureClass; repairs: number; sameClass: number; identical: number; elapsedMs: number; tokens?: number; costUsd?: number }): string | undefined {
  if (input.kind !== 'verification') return `Recovery requires owner reconciliation for ${input.kind}`;
  if (input.repairs >= policy.maxRepairs || input.sameClass >= policy.perErrorCap || input.identical >= policy.repeatCap) return 'Recovery attempt or identical-failure bound reached';
  if (input.elapsedMs >= policy.maxElapsedMs || input.tokens === undefined || input.tokens >= policy.maxTokens || policy.maxCostUsd !== undefined && (input.costUsd === undefined || input.costUsd >= policy.maxCostUsd)) return 'Recovery time/token/cost budget exhausted or required accounting unavailable';
  return undefined;
}
