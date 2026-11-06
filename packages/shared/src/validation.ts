import { isAbsolute, posix } from 'node:path';
import { ValidationError } from './errors.js';
import { redactForDiagnostics } from './redact.js';
import type { TaskSpec, PortableCheckpoint } from './domain.js';

export function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new ValidationError(path, 'expected an object');
  return value as Record<string, unknown>;
}
export function keys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new ValidationError(path, 'contains unknown fields');
}
export function text(value: unknown, path: string, max = 10_000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new ValidationError(path, `expected nonempty text up to ${max} characters`);
  return value;
}
export function identifier(value: unknown, path: string): string {
  const result = text(value, path, 100);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(result)) throw new ValidationError(path, 'expected an identifier using letters, numbers, dot, underscore or dash');
  return result;
}
export function choice<T extends string>(value: unknown, options: readonly T[], path: string): T {
  if (typeof value !== 'string' || !options.includes(value as T)) throw new ValidationError(path, `expected one of ${options.join(', ')}`);
  return value as T;
}
export function integer(value: unknown, min: number, max: number, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new ValidationError(path, `expected an integer from ${min} to ${max}`);
  return value;
}
export function list(value: unknown, path: string, min = 0, max = 100): string[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw new ValidationError(path, `expected ${min}–${max} text entries`);
  const result = Array.from(value, (item, i) => text(item, `${path}[${i}]`));
  if (new Set(result).size !== result.length) throw new ValidationError(path, 'duplicate entries are not allowed');
  return result;
}
export function relativePath(value: unknown, path: string): string {
  const result = text(value, path, 1000);
  if (isAbsolute(result) || /^[A-Za-z]:/.test(result) || result.includes('\\') || /[\x00-\x1f]/.test(result) || result.split('/').some(part => !part || part === '.' || part === '..')) throw new ValidationError(path, 'expected a relative workspace path without traversal');
  return result;
}
function version(value: Record<string, unknown>, path: string): void {
  if (value.schemaVersion !== 1) throw new ValidationError(`${path}.schemaVersion`, 'only schema version 1 is supported', 'UNSUPPORTED_SCHEMA');
}
export function validateTaskSpec(input: unknown): TaskSpec {
  const p = 'task'; const v = record(input, p); version(v, p);
  keys(v, ['schemaVersion', 'id', 'projectId', 'title', 'objective', 'scope', 'acceptance', 'dependsOn', 'priority', 'risk', 'mode', 'preferredHarness', 'verificationProfile', 'requiresApprovalFor', 'maxAttempts', 'maxWallMinutes', 'metadata'], p);
  const scope = record(v.scope, 'task.scope'); keys(scope, ['include', 'exclude'], 'task.scope');
  const metadata = record(v.metadata, 'task.metadata'); keys(metadata, ['source', 'externalId'], 'task.metadata');
  const id = identifier(v.id, 'task.id');
  const dependsOn = list(v.dependsOn, 'task.dependsOn').map((item, i) => identifier(item, `task.dependsOn[${i}]`));
  if (dependsOn.includes(id)) throw new ValidationError('task.dependsOn', 'a task cannot depend on itself');
  return { schemaVersion: 1, id, projectId: identifier(v.projectId, 'task.projectId'), title: text(v.title, 'task.title', 200), objective: text(v.objective, 'task.objective'),
    scope: { include: list(scope.include, 'task.scope.include', 1).map(item => relativePath(item, 'task.scope.include')), exclude: list(scope.exclude, 'task.scope.exclude').map(item => relativePath(item, 'task.scope.exclude')) },
    acceptance: list(v.acceptance, 'task.acceptance', 1), dependsOn,
    priority: choice(v.priority, ['low', 'normal', 'high', 'urgent'], 'task.priority'), risk: choice(v.risk, ['low', 'medium', 'high'], 'task.risk'),
    mode: choice(v.mode, ['delegated', 'interactive'], 'task.mode'), preferredHarness: choice(v.preferredHarness, ['auto', 'codex', 'opencode'], 'task.preferredHarness'),
    verificationProfile: identifier(v.verificationProfile, 'task.verificationProfile'),
    requiresApprovalFor: list(v.requiresApprovalFor, 'task.requiresApprovalFor').map(item => choice(item, ['deployment', 'destructive_db', 'external_write', 'payment', 'secret_write'], 'task.requiresApprovalFor')),
    maxAttempts: integer(v.maxAttempts, 1, 10, 'task.maxAttempts'), maxWallMinutes: integer(v.maxWallMinutes, 1, 1440, 'task.maxWallMinutes'),
    metadata: { source: choice(metadata.source, ['cli', 'discord', 'local'], 'task.metadata.source'), ...(metadata.externalId === undefined ? {} : { externalId: text(metadata.externalId, 'task.metadata.externalId', 200) }) },
  };
}
export function validateCheckpoint(input: unknown): PortableCheckpoint {
  const p = 'checkpoint'; const v = record(input, p); version(v, p);
  keys(v, ['schemaVersion', 'taskId', 'attemptId', 'projectId', 'baseCommit', 'branch', 'worktree', 'objective', 'completedSteps', 'pendingSteps', 'decisions', 'changedFiles', 'knownBlockers', 'lastVerification', 'sessionRefs', 'artifactHashes'], p);
  const verification = record(v.lastVerification, 'checkpoint.lastVerification'); keys(verification, ['status', 'reason'], 'checkpoint.lastVerification');
  const sessions = record(v.sessionRefs, 'checkpoint.sessionRefs'); keys(sessions, ['codex', 'opencode'], 'checkpoint.sessionRefs');
  const sessionRefs: PortableCheckpoint['sessionRefs'] = {};
  for (const key of ['codex', 'opencode'] as const) if (sessions[key] !== undefined) sessionRefs[key] = text(sessions[key], `checkpoint.sessionRefs.${key}`, 200);
  const hashes = record(v.artifactHashes, 'checkpoint.artifactHashes'); const artifactHashes: Record<string, string> = {};
  if (Object.keys(hashes).length > 100) throw new ValidationError('checkpoint.artifactHashes', 'expected at most 100 artifact hashes');
  for (const [key, hash] of Object.entries(hashes)) {
    identifier(key, 'checkpoint.artifactHashes.key');
    if (['__proto__', 'constructor', 'prototype'].includes(key) || typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) throw new ValidationError('checkpoint.artifactHashes', 'expected named SHA-256 hashes');
    artifactHashes[key] = hash;
  }
  const baseCommit = text(v.baseCommit, 'checkpoint.baseCommit', 64);
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(baseCommit)) throw new ValidationError('checkpoint.baseCommit', 'expected a Git commit hash');
  const branch = relativePath(v.branch, 'checkpoint.branch');
  if (branch.startsWith('-') || /[ ~^:?*\[\]]|@\{|\.\.|\/\//.test(branch) || branch.endsWith('.') || branch.split('/').some(part => part.startsWith('.') || part.endsWith('.lock'))) throw new ValidationError('checkpoint.branch', 'expected a Git branch name');
  const worktree = text(v.worktree, 'checkpoint.worktree', 4096);
  if (!posix.isAbsolute(worktree) || posix.normalize(worktree) !== worktree || /[\x00-\x1f\\]/.test(worktree)) throw new ValidationError('checkpoint.worktree', 'expected a canonical absolute workspace path');
  return { schemaVersion: 1, taskId: identifier(v.taskId, 'checkpoint.taskId'), attemptId: identifier(v.attemptId, 'checkpoint.attemptId'), projectId: identifier(v.projectId, 'checkpoint.projectId'), baseCommit, branch, worktree,
    objective: text(v.objective, 'checkpoint.objective'), completedSteps: list(v.completedSteps, 'checkpoint.completedSteps'), pendingSteps: list(v.pendingSteps, 'checkpoint.pendingSteps'), decisions: list(v.decisions, 'checkpoint.decisions'), knownBlockers: list(v.knownBlockers, 'checkpoint.knownBlockers'),
    changedFiles: list(v.changedFiles, 'checkpoint.changedFiles', 0, 1000).map(item => relativePath(item, 'checkpoint.changedFiles')),
    lastVerification: { status: choice(verification.status, ['passed', 'failed', 'unavailable', 'cancelled', 'not_run'], 'checkpoint.lastVerification.status'), reason: text(verification.reason, 'checkpoint.lastVerification.reason') }, sessionRefs, artifactHashes };
}
const maxJsonBytes = 1_000_000;
function parse(json: string): unknown {
  if (typeof json !== 'string' || Buffer.byteLength(json) > maxJsonBytes) throw new ValidationError('json', 'expected JSON of at most 1 MB');
  try { return JSON.parse(json); } catch { throw new ValidationError('json', 'invalid JSON'); }
}
function serialize<T>(value: T, validate: (input: unknown) => T, env: NodeJS.ProcessEnv): string {
  // Sanitize string values before encoding, so escaped credentials cannot evade redaction.
  // Schema validation rejects explicit credential fields; this handles incidental known values.
  const sanitized: unknown = JSON.parse(JSON.stringify(value, (_key, item: unknown) => typeof item === 'string' ? redactForDiagnostics(item, env) : item));
  const json = JSON.stringify(validate(sanitized));
  if (Buffer.byteLength(json + '\n') > maxJsonBytes) throw new ValidationError('json', 'serialized document exceeds 1 MB');
  return json + '\n';
}
export const parseTaskSpec = (json: string): TaskSpec => validateTaskSpec(parse(json));
export const serializeTaskSpec = (value: TaskSpec, env: NodeJS.ProcessEnv = process.env): string => serialize(validateTaskSpec(value), validateTaskSpec, env);
export const parseCheckpoint = (json: string): PortableCheckpoint => validateCheckpoint(parse(json));
export const serializeCheckpoint = (value: PortableCheckpoint, env: NodeJS.ProcessEnv = process.env): string => serialize(validateCheckpoint(value), validateCheckpoint, env);
