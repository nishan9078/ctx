import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { CtxConfig, ProjectConfig, ResolvedProjectConfig } from '../../shared/src/config.js';
import { redactForDiagnostics } from '../../shared/src/redact.js';
import { CtxError, ValidationError } from '../../shared/src/errors.js';
import { choice, identifier, integer, keys, list, record, text } from '../../shared/src/validation.js';
export type { CtxConfig, ProjectConfig, ResolvedProjectConfig } from '../../shared/src/config.js';

const optional = (value: unknown, fallback: unknown): unknown => value === undefined ? fallback : value;
const approvalActions = ['deployment', 'destructive_db', 'external_write', 'payment', 'secret_write'] as const;
function boolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new ValidationError(path, 'expected a boolean');
  return value;
}
function absolute(value: unknown, path: string): string {
  const result = text(value, path, 4096);
  if (!isAbsolute(result) || /[\x00-\x1f]/.test(result)) throw new ValidationError(path, 'expected an absolute local repository path');
  return result;
}
/** Trusted owner configuration only. Missing sections receive conservative local defaults. */
export function validateConfig(input: unknown): CtxConfig {
  const v = record(input, 'config'); keys(v, ['schemaVersion', 'runtime', 'capacity', 'notifications', 'security', 'projects'], 'config');
  if (v.schemaVersion !== 1) throw new ValidationError('config.schemaVersion', 'only schema version 1 is supported', 'UNSUPPORTED_SCHEMA');
  const runtime = record(optional(v.runtime, {}), 'config.runtime'); keys(runtime, ['mode', 'maxWorkers', 'maxWorkersPerProject', 'idleWorkerShutdownSeconds', 'diskFreeMinGb', 'maxAttemptWallMinutes', 'shutdownGraceSeconds', 'maxWorkerRssMb', 'maxWorkerCpuSeconds', 'maxWorkspaceMb', 'worktreeRetentionDays'], 'config.runtime');
  const capacity = record(optional(v.capacity, {}), 'config.capacity'); keys(capacity, ['probePaidEndpoints', 'unknownLimitBackoffSeconds'], 'config.capacity');
  const notifications = record(optional(v.notifications, {}), 'config.notifications'); keys(notifications, ['discord', 'eventTypes'], 'config.notifications');
  const security = record(optional(v.security, {}), 'config.security'); keys(security, ['defaultNetwork', 'requireApproval', 'allowRepositories'], 'config.security');
  if (!Array.isArray(v.projects) || v.projects.length > 100) throw new ValidationError('config.projects', 'expected 0–100 registered projects');
  const projects: ProjectConfig[] = Array.from(v.projects, (entry, index) => {
    const p = `config.projects[${index}]`; const project = record(entry, p); keys(project, ['id', 'repositoryPath', 'verificationProfile', 'commands'], p);
    const commands = record(optional(project.commands, {}), `${p}.commands`); keys(commands, ['build', 'test', 'typecheck', 'security', 'browser'], `${p}.commands`);
    return { id: identifier(project.id, `${p}.id`), repositoryPath: absolute(project.repositoryPath, `${p}.repositoryPath`), verificationProfile: identifier(project.verificationProfile, `${p}.verificationProfile`),
      commands: Object.fromEntries(Object.entries(commands).map(([key, value]) => [key, text(value, `${p}.commands.${key}`)])) };
  });
  if (new Set(projects.map(project => project.id)).size !== projects.length) throw new ValidationError('config.projects', 'duplicate project IDs');
  const backoff = optional(capacity.unknownLimitBackoffSeconds, [60, 180, 600, 1800]);
  if (!Array.isArray(backoff) || !backoff.length || backoff.length > 10) throw new ValidationError('config.capacity.unknownLimitBackoffSeconds', 'expected 1–10 increasing delays');
  const delays = Array.from(backoff, (value, i) => integer(value, 1, 86400, `config.capacity.unknownLimitBackoffSeconds[${i}]`));
  if (delays.some((value, i) => i > 0 && value <= delays[i - 1])) throw new ValidationError('config.capacity.unknownLimitBackoffSeconds', 'delays must strictly increase');
  const config: CtxConfig = { schemaVersion: 1, projects,
    runtime: { mode: choice(optional(runtime.mode, 'local'), ['local'], 'config.runtime.mode'), maxWorkers: integer(optional(runtime.maxWorkers, 1), 1, 2, 'config.runtime.maxWorkers'), maxWorkersPerProject: integer(optional(runtime.maxWorkersPerProject, 1), 1, 2, 'config.runtime.maxWorkersPerProject'),
      idleWorkerShutdownSeconds: integer(optional(runtime.idleWorkerShutdownSeconds, 30), 0, 3600, 'config.runtime.idleWorkerShutdownSeconds'), diskFreeMinGb: integer(optional(runtime.diskFreeMinGb, 10), 1, 10000, 'config.runtime.diskFreeMinGb'), maxAttemptWallMinutes: integer(optional(runtime.maxAttemptWallMinutes, 90), 1, 1440, 'config.runtime.maxAttemptWallMinutes'), shutdownGraceSeconds: integer(optional(runtime.shutdownGraceSeconds, 20), 1, 120, 'config.runtime.shutdownGraceSeconds'), maxWorkerRssMb: integer(optional(runtime.maxWorkerRssMb, 2048), 128, 1048576, 'config.runtime.maxWorkerRssMb'), maxWorkerCpuSeconds: integer(optional(runtime.maxWorkerCpuSeconds, 3600), 1, 86400, 'config.runtime.maxWorkerCpuSeconds'), maxWorkspaceMb: integer(optional(runtime.maxWorkspaceMb, 2048), 16, 1048576, 'config.runtime.maxWorkspaceMb'), worktreeRetentionDays: integer(optional(runtime.worktreeRetentionDays, 7), 0, 3650, 'config.runtime.worktreeRetentionDays') },
    capacity: { probePaidEndpoints: boolean(optional(capacity.probePaidEndpoints, false), 'config.capacity.probePaidEndpoints'), unknownLimitBackoffSeconds: delays },
    notifications: { discord: boolean(optional(notifications.discord, false), 'config.notifications.discord'), eventTypes: list(optional(notifications.eventTypes, ['completed', 'blocked', 'approval_requested', 'capacity_wait']), 'config.notifications.eventTypes').map(value => choice(value, ['accepted', 'progress', 'completed', 'blocked', 'approval_requested', 'capacity_wait'], 'config.notifications.eventTypes')) },
    security: { defaultNetwork: choice(optional(security.defaultNetwork, 'restricted'), ['restricted'], 'config.security.defaultNetwork'), requireApproval: list(optional(security.requireApproval, [...approvalActions]), 'config.security.requireApproval').map(value => choice(value, approvalActions, 'config.security.requireApproval')), allowRepositories: list(optional(security.allowRepositories, []), 'config.security.allowRepositories').map(value => absolute(value, 'config.security.allowRepositories')) },
  };
  if (config.runtime.maxWorkersPerProject > config.runtime.maxWorkers) throw new ValidationError('config.runtime.maxWorkersPerProject', 'must not exceed maxWorkers');
  return config;
}

/** Defaults < owner config < supported runtime environment overrides. Permissions never come from env. */
export async function resolveProjectConfig(input: unknown, projectId: string, env: NodeJS.ProcessEnv = process.env): Promise<ResolvedProjectConfig> {
  const config = validateConfig(input);
  for (const [key, field] of [['CTX_MAX_WORKERS', 'maxWorkers'], ['CTX_MAX_WORKERS_PER_PROJECT', 'maxWorkersPerProject'], ['CTX_MAX_ATTEMPT_WALL_MINUTES', 'maxAttemptWallMinutes']] as const) {
    if (env[key] !== undefined) {
      if (!/^[1-9][0-9]*$/.test(env[key]!)) throw new ValidationError(`environment.${key}`, 'expected a positive decimal integer');
      config.runtime[field] = Number(env[key]);
    }
  }
  validateConfig(config); // Validate bounds and cross-field constraints after all overrides.
  const project = config.projects.find(value => value.id === projectId);
  if (!project) throw new CtxError('UNAUTHORIZED', 'Project is not registered');
  // Resolve aliases before comparing exact paths. A parent directory never authorizes its children.
  let allowed: string[];
  try { allowed = await Promise.all(config.security.allowRepositories.map(path => realpath(path))); }
  catch { throw new CtxError('ENVIRONMENT_UNAVAILABLE', 'An allowed repository path is inaccessible'); }
  let canonical: string;
  try { canonical = await realpath(project.repositoryPath); if (!(await stat(canonical)).isDirectory()) throw new Error(); }
  catch { throw new CtxError('ENVIRONMENT_UNAVAILABLE', 'Registered repository is not an accessible directory'); }
  if (!allowed.includes(canonical)) throw new CtxError('UNAUTHORIZED', 'Registered repository is not explicitly allowed');
  project.repositoryPath = canonical;
  config.security.allowRepositories = [...new Set(allowed)];
  return { config, project };
}

/** Use this view for logs/UI; the operational config may contain command arguments. */
export function projectConfigDiagnostics(config: ResolvedProjectConfig, env: NodeJS.ProcessEnv = process.env): unknown {
  return redactForDiagnostics(config, env);
}
