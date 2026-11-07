import { createHash } from 'node:crypto';
import { CtxError, ValidationError } from './errors.js';
import { identifier, integer, keys, record, relativePath, text } from './validation.js';
export const gateStatuses = ['passed', 'failed', 'unavailable', 'cancelled', 'not_run', 'not_applicable', 'skipped_with_approval', 'mock_verified'] as const;
export type GateStatus = typeof gateStatuses[number];
export type GateKind = 'scope' | 'test_integrity' | 'secrets' | 'syntax' | 'acceptance' | 'dependencies' | 'command' | 'codex_security';
export interface GateStep {
  id: string; kind: GateKind; required: boolean; waivable: boolean; timeoutMs: number;
  command?: { program: string; args: string[] };
  role?: 'typecheck' | 'test' | 'build' | 'lint' | 'scan' | 'custom';
  testReport?: { format: 'tap' | 'pytest'; minimumTests: number };
  criteria?: ({ kind: 'directory' | 'file' | 'markdown'; path: string } | { kind: 'content'; path: string; content: string; match: 'exact' | 'contains' })[];
  advisories?: { source: string; asOf: string; entries: { id: string; name: string; version: string; severity: 'critical' | 'high' | 'medium' | 'low' }[] };
  enabled?: boolean; maxCostUsd?: number;
  integration: 'live' | 'mock';
}
export interface VerificationProfile {
  schemaVersion: 1; id: string; purpose: 'code' | 'filesystem' | 'documentation';
  backend: 'none' | 'host' | 'docker'; generatedPaths: string[]; protectedPaths: string[];
  steps: GateStep[];
}
export interface FrozenVerificationProfile { attemptId: string; taskSpecHash: string; profileHash?: string; ownerId?: string; profile?: VerificationProfile }
export interface VerificationWaiver {
  id: string; taskId: string; taskSpecHash: string; profileHash: string; stepId: string; attemptSequence: number;
  reason: string; approvedBy: string; expiresAt: string; createdAt: string; usedByAttempt?: string;
}
export interface GateFinding { id: string; scanner: string; severity: 'critical' | 'high' | 'medium' | 'low' | 'informational'; message: string; path?: string; line?: number; fingerprint?: string }
export interface GateStepResult {
  id: string; kind: GateKind; required: boolean; status: GateStatus; observedStatus: GateStatus;
  startedAt: string; endedAt: string; durationMs: number; command?: string[]; exitCode: number | null; timedOut: boolean;
  stdoutArtifactId: string; stderrArtifactId: string; findings: GateFinding[]; limitations: string[]; waiverId?: string;
  environment: { backend: 'builtin' | 'none' | 'host' | 'docker' | 'mock'; node: string; platform: string; cwd: string; timeoutMs: number };
}
export interface GateReport {
  schemaVersion: 1; id: string; taskId: string; attemptId: string; taskSpecHash: string;
  profileId: string; profileHash?: string; workspaceId?: string; workspaceHash?: string; baseSha?: string; resultSha?: string;
  status: 'passed' | 'passed_with_waivers' | 'failed' | 'unavailable' | 'cancelled' | 'mock_verified';
  steps: GateStepResult[]; artifactIds: string[]; limitations: string[]; startedAt: string; endedAt: string;
  harnessOutcome: 'completed' | 'failed' | 'interrupted';
}
export const verificationHash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const flag = (value: unknown, path: string, fallback = false): boolean => { if (value === undefined) return fallback; if (typeof value !== 'boolean') throw new ValidationError(path, 'expected boolean'); return value; };
const strings = (value: unknown, path: string, maximum = 100): string[] => { if (!Array.isArray(value) || value.length > maximum) throw new ValidationError(path, 'expected a bounded array'); return value.map(item => text(item, path, 4096)); };
export function validateVerificationProfile(input: unknown): VerificationProfile {
  const value = record(input, 'profile'); keys(value, ['schemaVersion','id','purpose','backend','generatedPaths','protectedPaths','steps'], 'profile');
  if (value.schemaVersion !== 1) throw new ValidationError('profile.schemaVersion', 'only version 1 is supported');
  if (!['code','filesystem','documentation'].includes(String(value.purpose)) || !['none','host','docker'].includes(String(value.backend))) throw new ValidationError('profile', 'explicit purpose and execution backend are required');
  if (!Array.isArray(value.steps) || !value.steps.length || value.steps.length > 30) throw new ValidationError('profile.steps', 'expected 1–30 checks');
  const steps: GateStep[] = value.steps.map((input, index) => {
    const step = record(input, `profile.steps[${index}]`); keys(step, ['id','kind','required','waivable','timeoutMs','command','role','testReport','criteria','advisories','enabled','maxCostUsd','integration'], 'step');
    const id = identifier(step.id, 'step.id'); const kind = step.kind as GateKind;
    if (!['scope','test_integrity','secrets','syntax','acceptance','dependencies','command','codex_security'].includes(kind)) throw new ValidationError('step.kind', 'unknown check');
    const result: GateStep = { id, kind, required: flag(step.required, 'step.required', true), waivable: flag(step.waivable, 'step.waivable'), timeoutMs: integer(step.timeoutMs ?? 180000, 100, 600000, 'step.timeoutMs'), integration: step.integration === undefined ? 'live' : step.integration as 'live' | 'mock' };
    if (!['live','mock'].includes(result.integration)) throw new ValidationError('step.integration', 'expected live or mock');
    if (['scope','test_integrity'].includes(kind) && result.waivable) throw new ValidationError('step.waivable', 'scope and test integrity cannot be waived');
    if (kind === 'command') {
      const command = record(step.command, 'step.command'); keys(command, ['program','args'], 'step.command');
      const program = text(command.program, 'command.program', 4096); const base = program.split('/').at(-1)!;
      if (program !== base && (!program.startsWith('/') || program.split('/').some(part => part === '..' || part === '.'))) throw new ValidationError('command.program', 'executables must be supported names or absolute owner-approved paths');
      if (!['node','npm','pnpm','python3','pytest','tsc','eslint','ruff','gitleaks','semgrep','osv-scanner','cargo','go'].includes(base) || program.includes('\0')) throw new ValidationError('command.program', 'expected an explicitly supported local verification tool');
      if (!Array.isArray(command.args) || command.args.length > 100 || command.args.some(arg => typeof arg !== 'string' || arg.length > 4096 || arg.includes('\0'))) throw new ValidationError('command.args', 'expected bounded argv strings');
      result.command = { program, args: command.args as string[] };
      if (!['typecheck','test','build','lint','scan','custom'].includes(String(step.role))) throw new ValidationError('step.role', 'command role is required'); result.role = step.role as GateStep['role'];
      if (result.role === 'test') {
        const evidence = record(step.testReport, 'step.testReport'); keys(evidence, ['format','minimumTests'], 'step.testReport');
        if (!['tap','pytest'].includes(String(evidence.format))) throw new ValidationError('testReport.format', 'supported independent test summary is required');
        result.testReport = { format: evidence.format as 'tap' | 'pytest', minimumTests: integer(evidence.minimumTests ?? 1, 1, 1000000, 'minimumTests') };
      }
    } else if (step.command !== undefined || step.role !== undefined || step.testReport !== undefined) throw new ValidationError('step.command', 'only command checks carry argv and test evidence');
    if (kind === 'acceptance') {
      if (!Array.isArray(step.criteria) || !step.criteria.length || step.criteria.length > 50) throw new ValidationError('criteria', 'explicit deterministic acceptance criteria are required');
      result.criteria = step.criteria.map(input => { const item = record(input, 'criterion'); keys(item, ['kind','path','content','match'], 'criterion'); const path = relativePath(item.path, 'criterion.path');
        if (item.kind === 'content') { if (typeof item.content !== 'string' || item.content.length > 100000) throw new ValidationError('criterion.content', 'expected bounded content'); const match = item.match ?? 'exact'; if (!['exact','contains'].includes(String(match))) throw new ValidationError('criterion.match', 'expected exact or contains'); return { kind: 'content', path, content: item.content, match: match as 'exact' | 'contains' }; }
        if (!['file','directory','markdown'].includes(String(item.kind))) throw new ValidationError('criterion.kind', 'unknown criterion'); return { kind: item.kind as 'file' | 'directory' | 'markdown', path };
      });
    } else if (step.criteria !== undefined) throw new ValidationError('criteria', 'only acceptance checks carry criteria');
    if (kind === 'dependencies' && step.advisories !== undefined) {
      const db = record(step.advisories, 'advisories'); keys(db, ['source','asOf','entries'], 'advisories');
      if (!Array.isArray(db.entries) || db.entries.length > 1000) throw new ValidationError('advisories.entries', 'expected a bounded advisory snapshot');
      result.advisories = { source: text(db.source, 'advisories.source'), asOf: text(db.asOf, 'advisories.asOf'), entries: db.entries.map(input => { const item = record(input, 'advisory'); keys(item, ['id','name','version','severity'], 'advisory'); if (!['critical','high','medium','low'].includes(String(item.severity))) throw new ValidationError('advisory.severity', 'unknown severity'); return { id: identifier(item.id, 'advisory.id'), name: text(item.name, 'advisory.name'), version: text(item.version, 'advisory.version'), severity: item.severity as 'critical' | 'high' | 'medium' | 'low' }; }) };
    } else if (step.advisories !== undefined) throw new ValidationError('advisories', 'only dependency checks use advisory snapshots');
    if (kind === 'codex_security') { result.enabled = flag(step.enabled, 'step.enabled'); if (result.enabled) { if (typeof step.maxCostUsd !== 'number' || !Number.isFinite(step.maxCostUsd) || step.maxCostUsd <= 0 || step.maxCostUsd > 10) throw new ValidationError('maxCostUsd', 'an explicit positive scanner budget up to 10 USD is required'); result.maxCostUsd = step.maxCostUsd; } }
    else if (step.enabled !== undefined || step.maxCostUsd !== undefined) throw new ValidationError('step.enabled', 'only Codex Security uses paid scanner opt-in');
    return result;
  });
  if (new Set(steps.map(step => step.id)).size !== steps.length) throw new ValidationError('profile.steps', 'duplicate IDs are forbidden');
  for (const kind of ['scope','test_integrity','secrets'] as const) if (!steps.some(step => step.kind === kind && step.required && step.integration === 'live')) throw new ValidationError('profile.steps', `a required independent ${kind} check must be explicitly configured`);
  if (value.purpose === 'code' && (!steps.some(step => step.role === 'test' && step.required) || !steps.some(step => step.kind === 'syntax' && step.required) || !steps.some(step => step.kind === 'dependencies' && step.required))) throw new ValidationError('profile.steps', 'code profiles require tests, syntax and dependency checks');
  return { schemaVersion: 1, id: identifier(value.id, 'profile.id'), purpose: value.purpose as VerificationProfile['purpose'], backend: value.backend as VerificationProfile['backend'], generatedPaths: strings(value.generatedPaths ?? [], 'profile.generatedPaths').map(path => relativePath(path, 'profile.generatedPaths')), protectedPaths: strings(value.protectedPaths ?? [], 'profile.protectedPaths').map(path => relativePath(path, 'profile.protectedPaths')), steps };
}
export function assertExactGateSet(profile: VerificationProfile, steps: GateStepResult[]): void {
  if (steps.length !== profile.steps.length || new Set(steps.map(step => step.id)).size !== steps.length) throw new CtxError('CONFLICT', 'Verification report does not contain exactly the configured checks');
  for (const expected of profile.steps) { const actual = steps.find(step => step.id === expected.id); if (!actual || actual.required !== expected.required || actual.kind !== expected.kind || JSON.stringify(actual.command) !== JSON.stringify(expected.command ? [expected.command.program, ...expected.command.args] : undefined)) throw new CtxError('CONFLICT', 'Verification gate definition changed after binding'); }
}

export function gateReportStatus(profile: VerificationProfile | undefined, steps: GateStepResult[], harnessOutcome: GateReport['harnessOutcome']): GateReport['status'] {
  if (harnessOutcome === 'interrupted') return 'cancelled';
  if (harnessOutcome === 'failed') return 'failed';
  if (!profile) return 'unavailable';
  assertExactGateSet(profile, steps);
  const required = steps.filter(step => step.required);
  if (required.some(step => step.status === 'cancelled')) return 'cancelled';
  if (required.some(step => step.status === 'failed')) return 'failed';
  if (required.some(step => step.status === 'mock_verified')) return 'mock_verified';
  if (required.some(step => !['passed','skipped_with_approval'].includes(step.status))) return 'unavailable';
  return steps.some(step => step.status === 'skipped_with_approval') ? 'passed_with_waivers' : 'passed';
}
