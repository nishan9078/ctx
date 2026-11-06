import { runProcess } from './process-manager.js';
import type { DockerDriver, EnvironmentConfig, ManagedResource } from './types.js';
import { EnvironmentUnavailable } from './types.js';
import { dockerFailure, diagnoseDockerAccess, DockerAccessError, isDockerAccessDenied } from './docker-diagnostics.js';
import { redact } from '../../shared/src/redact.js';
export class LocalDockerDriver implements DockerDriver {
  readonly kind = 'live' as const;
  private readonly environment: NodeJS.ProcessEnv;
  constructor(private readonly execute: typeof runProcess = runProcess, environment: NodeJS.ProcessEnv = process.env) {
    // Keep the chosen daemon, credentials selectors and proxy environment stable
    // across preflight, provisioning, checks and cleanup. Do not drop identity.
    this.environment = { ...environment };
  }
  async command(args: string[], signal?: AbortSignal, timeoutMs?: number) {
    try {
      const result = await this.execute('docker', args, process.cwd(), { signal, timeoutMs: timeoutMs ?? 30_000, env: this.environment });
      if (result.code !== 0 && isDockerAccessDenied(result.output)) {
        throw new DockerAccessError(`Docker access failed: ${redact(result.output)}`, await diagnoseDockerAccess(result.output, args[0] ?? 'unknown'));
      }
      if ((result.code !== 0 || result.timedOut) && args[0] === 'info') throw dockerFailure('daemon-unavailable', 'info', `Docker daemon unavailable: ${redact(result.output)}`, 'Check the selected Docker endpoint and start or reconnect the daemon using your approved host configuration. Alternatively explicitly select --execution host or approve --allow-host-fallback with --execution auto.');
      return result;
    } catch (error) {
      if (error instanceof EnvironmentUnavailable) throw error;
      throw new EnvironmentUnavailable(`Docker unavailable: ${redact(String(error))}`);
    }
  }
}
export interface DockerObject {
  Config?: { Labels?: Record<string, string> }; Labels?: Record<string, string>;
  State?: { Running?: boolean }; Internal?: boolean;
}
export async function inspectOwned(driver: DockerDriver, taskId: string, resource: ManagedResource, signal?: AbortSignal): Promise<DockerObject | undefined> {
  const result = await driver.command([resource.kind === 'network' ? 'network' : 'container', 'inspect', resource.name], signal);
  if (result.code !== 0) {
    if (/No such (?:object|container|network)|not found/i.test(result.output)) return undefined;
    throw new EnvironmentUnavailable(`Cannot inspect ${resource.name}: ${result.output}`);
  }
  let item: DockerObject;
  try { const data = JSON.parse(result.output); if (!Array.isArray(data) || data.length !== 1) throw new Error(); item = data[0]; }
  catch { throw new EnvironmentUnavailable(`Malformed Docker inspection response for ${resource.name}`); }
  const labels = resource.kind === 'network' ? item.Labels : item.Config?.Labels;
  if (labels?.['harness.task'] !== taskId || labels?.['harness.purpose'] !== resource.purpose) throw new EnvironmentUnavailable(`Refusing to adopt or remove foreign Docker resource: ${resource.name}`);
  if (resource.kind === 'network' && item.Internal !== true) throw new EnvironmentUnavailable('Task network is not internal');
  return item;
}
export function sandboxArgs(config: EnvironmentConfig, workspace: string, network: string, name: string, taskId: string, purpose: string, variables: Record<string, string>, gitMetadata?: string, externalNetwork = false): string[] {
  if (workspace.includes(',') || gitMetadata?.includes(',')) throw new Error('Docker bind paths containing commas are unsupported');
  const args = ['run', '--name', name, '--label', `harness.task=${taskId}`, '--label', `harness.purpose=${purpose}`,
    '--pull', config.allowImagePull ? 'missing' : 'never', '--init', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
    '--memory=512m', '--cpus=1', '--pids-limit=128', '--user', `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
    '--network', externalNetwork ? 'bridge' : network, '--tmpfs', '/tmp:rw,nosuid,nodev,size=128m,mode=1777',
    '--mount', `type=bind,src=${workspace},dst=${workspace}`, '--workdir', workspace,
    '--env', 'HOME=/tmp', '--env', 'CI=true', '--env', 'NODE_ENV=test'];
  if (gitMetadata) args.push('--mount', `type=bind,src=${gitMetadata},dst=${gitMetadata},readonly`);
  if (!externalNetwork) {
    // Block automatic client proxy injection into an intentionally offline sandbox.
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) args.push('--env', `${key}=`);
    args.push('--env', 'NO_PROXY=*', '--env', 'no_proxy=*');
  } else {
    // Network permission applies only to explicitly opted-in dependency installation.
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy']) if (process.env[key]) args.push('--env', key);
    if (process.env.CODEX_PROXY_CERT) {
      if (process.env.CODEX_PROXY_CERT.includes(',')) throw new Error('Unsupported proxy CA path');
      args.push('--mount', `type=bind,src=${process.env.CODEX_PROXY_CERT},dst=/run/harness-proxy-ca.pem,readonly`, '--env', 'NODE_EXTRA_CA_CERTS=/run/harness-proxy-ca.pem');
    }
  }
  for (const [key, value] of Object.entries(variables)) args.push('--env', `${key}=${value}`);
  return args;
}
