import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EnvironmentOptions, EnvironmentConfig, MockSpec } from './types.js';
const safeKey = (key: string) => /^[A-Z][A-Z0-9_]{0,79}$/.test(key) && !/^(PATH|HOME|NODE_OPTIONS|NODE_PATH|LD_.*|DYLD_.*|BASH_ENV|ENV|SHELLOPTS|GIT_.*|DOCKER_.*|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)$/.test(key);
export function validateMock(value: unknown): MockSpec {
  if (!value || typeof value !== 'object') throw new Error('Invalid mock specification');
  const mock = value as MockSpec;
  if (typeof mock.urlVariable !== 'string' || !safeKey(mock.urlVariable) || !mock.urlVariable.endsWith('_URL') || mock.urlVariable === 'DATABASE_URL' || !Array.isArray(mock.routes) || mock.routes.length === 0 || mock.routes.length > 100) throw new Error('Mock requires a safe URL variable and 1–100 routes');
  if (mock.keyVariable !== undefined && (!safeKey(mock.keyVariable) || !mock.keyVariable.endsWith('_API_KEY'))) throw new Error('Invalid mock key variable');
  const routes = mock.routes.map(route => {
    if (!route || !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(route.method) || typeof route.path !== 'string' || !route.path.startsWith('/') || route.path.startsWith('/__harness') || !Number.isInteger(route.status) || route.status < 200 || route.status > 599 || route.body === undefined) throw new Error('Invalid mock route');
    return { method: route.method, path: route.path, status: route.status, body: route.body };
  });
  if (JSON.stringify(routes).length > 100_000) throw new Error('Mock response configuration too large');
  if (new Set(routes.map(route => `${route.method} ${route.path}`)).size !== routes.length) throw new Error('Duplicate mock routes');
  return { urlVariable: mock.urlVariable, keyVariable: mock.keyVariable, routes };
}
export async function detectEnvironment(repository: string, options: EnvironmentOptions = {}): Promise<EnvironmentConfig> {
  let declared: { services?: EnvironmentOptions['services'] } = {};
  try {
    declared = JSON.parse(await readFile(join(repository, '.harness-environment.json'), 'utf8'));
    if (!declared || typeof declared !== 'object' || Object.keys(declared).some(key => key !== 'services')) throw new Error('Repository environment configuration may only declare services; permissions must come from CLI/API options');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  let example = ''; let dependencies: Record<string, unknown> = {};
  try { example = await readFile(join(repository, '.env.example'), 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  try { const pkg = JSON.parse(await readFile(join(repository, 'package.json'), 'utf8')); dependencies = { ...pkg.dependencies, ...pkg.devDependencies }; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const inferredPostgres = ('pg' in dependencies || 'postgres' in dependencies) && /(?:postgres(?:ql)?:\/\/|PGHOST\s*=)/i.test(example);
  const services = { postgres: inferredPostgres, ...declared.services, ...options.services };
  if (Object.keys(services).some(key => !['postgres', 'mock'].includes(key)) || (services.postgres !== undefined && typeof services.postgres !== 'boolean')) throw new Error('Unsupported environment service');
  const mock = services.mock === undefined ? undefined : validateMock(services.mock);
  const config: EnvironmentConfig = {
    mode: options.mode ?? 'docker', image: options.image ?? 'node:22-bookworm-slim',
    allowImagePull: options.allowImagePull ?? false, allowDependencyInstall: options.allowDependencyInstall ?? false,
    maxRecoveryAttempts: options.maxRecoveryAttempts ?? 3, services: { postgres: services.postgres, mock },
    envKeys: [...new Set([...example.matchAll(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/gm)].map(match => match[1]).filter(safeKey))],
  };
  if (!['docker', 'host'].includes(config.mode) || !/^[a-zA-Z0-9][a-zA-Z0-9_.\/:@-]{0,200}$/.test(config.image)) throw new Error('Invalid execution mode or Docker image');
  if (typeof config.allowImagePull !== 'boolean' || typeof config.allowDependencyInstall !== 'boolean' || !Number.isInteger(config.maxRecoveryAttempts) || config.maxRecoveryAttempts < 0 || config.maxRecoveryAttempts > 10) throw new Error('Invalid environment permissions or recovery budget');
  if (config.mode === 'host' && (services.postgres || mock || config.allowDependencyInstall)) throw new Error('Disposable services and dependency recovery require Docker mode');
  return config;
}
export async function installCommand(workspace: string): Promise<string | undefined> {
  const exists = async (file: string) => { try { await readFile(join(workspace, file)); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return false; } };
  if (await exists('pnpm-lock.yaml')) return 'corepack pnpm install --frozen-lockfile --ignore-scripts';
  if (await exists('package-lock.json')) return 'npm ci --ignore-scripts --no-audit --no-fund';
  return undefined;
}
