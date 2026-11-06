import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { redact } from '../../shared/src/redact.js';
import type { CheckResult } from '../../shared/src/contracts.js';
import type { ProcessResult } from './process-manager.js';
import { runProcess } from './process-manager.js';
import { worktreeMetadata } from './git-worktree.js';
import { classifyFailure } from './failure-classifier.js';
import { installCommand } from './service-detector.js';
import { DockerEnvironmentError, dockerFailure } from './docker-diagnostics.js';
import { inspectOwned, sandboxArgs, LocalDockerDriver } from './docker.js';
import { EnvironmentUnavailable, type DockerDriver, type EnvironmentState, type EnvironmentConfig, type ManagedResource, type CommandRunner, type RecoveryAttempt } from './types.js';
export interface EnvironmentHooks {
  get(): EnvironmentState;
  update(type: string, data: unknown, mutate: (state: EnvironmentState) => void): void;
}
export function createEnvironmentState(taskId: string, config: EnvironmentConfig): EnvironmentState {
  const variables: Record<string, string> = {};
  if (config.services.postgres) variables.DATABASE_URL = 'postgresql://harness:local-disposable@postgres:5432/harness';
  if (config.services.mock) variables[config.services.mock.urlVariable] = 'http://mock:8080';
  return { config, ready: false, network: `harness-${taskId}`, variables, resources: [], recoveries: [],
    remainingRecoveryAttempts: config.maxRecoveryAttempts, verificationRound: 0, dependencies: [], limitations: [], cleanupErrors: [] };
}
export class EnvironmentManager implements CommandRunner {
  constructor(private readonly taskId: string, private readonly workspace: string, private readonly directory: string, private readonly hooks: EnvironmentHooks, private readonly driver: DockerDriver = new LocalDockerDriver()) {}
  private get state() { return this.hooks.get(); }
  get canExecuteCommands() { return this.mode !== 'filesystem'; }
  get supportsBuiltInBrowser() { return this.mode === 'host'; }
  async ensureCommandBackend(signal?: AbortSignal): Promise<void> { if (this.mode !== 'filesystem') return; try { await this.prepareDocker(signal); } catch (error) { if (signal?.aborted || !(error instanceof EnvironmentUnavailable) || this.state.config.mode !== 'auto' || !this.state.config.allowHostFallback || this.state.resources.length || this.state.config.services.postgres || this.state.config.services.mock) throw error; this.update('selection.fallback', { explicitlyAllowed: true, reason: String(error) }, state => { state.selectedMode = 'host'; state.ready = true; state.limitations.push('Host verification explicitly permitted after generated project commands were discovered.'); }); } }
  private get mode() { return this.state.selectedMode ?? (this.state.config.mode === 'auto' ? 'docker' : this.state.config.mode); }
  private update(type: string, data: unknown, mutate: (state: EnvironmentState) => void) { this.hooks.update(`environment.${type}`, data, mutate); }
  private resource(name: string, kind: ManagedResource['kind'], purpose: string): ManagedResource {
    const existing = this.state.resources.find(resource => resource.name === name);
    if (existing) return existing;
    const resource: ManagedResource = { name, kind, purpose, status: 'intent' };
    this.update('resource.intent', resource, state => { state.resources.push(resource); }); return resource;
  }
  private mark(name: string, status: ManagedResource['status']) { this.update('resource.status', { name, status }, state => { state.resources.find(resource => resource.name === name)!.status = status; }); }
  private async command(args: string[], signal?: AbortSignal): Promise<string> {
    const result = await this.driver.command(args, signal);
    if (result.code !== 0 || result.timedOut) throw new EnvironmentUnavailable(`Docker command failed: ${redact(result.output)}`);
    return result.output;
  }
  async prepare(signal?: AbortSignal): Promise<void> {
    const config = this.state.config;
    if (this.state.selectedMode === 'filesystem' || config.mode === 'auto' && config.lightweight && !config.services.postgres && !config.services.mock) {
      this.update('selected', { mode: 'filesystem', reason: 'Deterministic filesystem acceptance; the verification backend executes no project commands.' }, state => { state.selectedMode = 'filesystem'; state.selectionReason = 'Deterministic filesystem acceptance; the verification backend executes no project commands.'; state.ready = true; }); return;
    }
    if (this.mode === 'host') {
      this.update('selected', { mode: 'host', explicit: config.mode === 'host' }, state => { state.selectedMode = 'host'; state.ready = true; }); return;
    }
    try { await this.prepareDocker(signal); }
    catch (error) {
      if (signal?.aborted || !(error instanceof EnvironmentUnavailable)) throw error;
      if (config.mode !== 'auto' || !config.allowHostFallback || config.services.postgres || config.services.mock || this.state.resources.length) throw error;
      this.update('selection.fallback', { mode: 'host', reason: String(error), diagnostic: error instanceof DockerEnvironmentError ? error.diagnostic : undefined, explicitlyAllowed: true }, state => {
        state.selectedMode = 'host'; state.ready = true; state.selectionReason = String(error);
        state.limitations.push('Docker unavailable; host verification selected with explicit allowHostFallback permission. Host project commands use current user permissions and are not container-isolated.');
      });
    }
  }
  private async prepareDocker(signal?: AbortSignal): Promise<void> {
    if (this.driver.kind === 'simulated' && !this.state.limitations.some(item => item.includes('simulated'))) this.update('adapter.simulated', {}, state => { state.limitations.push('Docker driver is simulated; no live Docker or PostgreSQL integration was verified.'); });
    await this.command(['info', '--format', '{{.ServerVersion}}'], signal);
    // Provision before spending a model turn. Image/cache failures must not be
    // confused with a denied socket or deferred to a workload's docker run.
    for (const image of new Set([this.state.config.image, ...(this.state.config.services.postgres ? ['postgres:16-bookworm'] : [])])) {
      const found = await this.driver.command(['image', 'inspect', image], signal);
      if (found.code === 0 && !found.timedOut) continue;
      if (found.timedOut || !/No such image|image[^\n]*not found/i.test(found.output)) throw new EnvironmentUnavailable(`Cannot inspect Docker image ${image}: ${redact(found.output)}`);
      if (!this.state.config.allowImagePull) throw dockerFailure('image-missing', 'image inspect', `Docker image ${image} unavailable. ${redact(found.output)}`, `Preload ${image} with an approved docker pull, or explicitly enable --allow-image-pull. No image was downloaded.`);
      this.update('image.pull.intent', { image }, () => {});
      const pulled = await this.driver.command(['pull', image], signal, 120_000);
      if (pulled.code !== 0 || pulled.timedOut) throw new EnvironmentUnavailable(`Docker image ${image} provisioning failed: ${redact(pulled.output)}`);
      const verified = await this.driver.command(['image', 'inspect', image], signal);
      if (verified.code !== 0 || verified.timedOut) throw new EnvironmentUnavailable(`Docker image ${image} unavailable after pull: ${redact(verified.output)}`);
      this.update('image.ready', { image }, () => {});
    }
    const network = this.resource(this.state.network, 'network', 'sandbox');
    if (!await inspectOwned(this.driver, this.taskId, network, signal)) await this.command(['network', 'create', '--internal', '--label', `harness.task=${this.taskId}`, '--label', 'harness.purpose=sandbox', network.name], signal);
    this.mark(network.name, 'ready');
    // Reconcile service containers before continuing a confirmed checkpoint.
    for (const dependency of this.state.dependencies.filter(item => item.verified)) {
      const resource = this.state.resources.find(item => item.purpose === dependency.name && item.kind === 'container');
      if (!resource || !(await inspectOwned(this.driver, this.taskId, resource, signal))?.State?.Running) throw new EnvironmentUnavailable(`Recovered dependency ${dependency.name} is no longer running; refusing to silently reset its data`);
      await this.health(resource, signal);
    }
    this.update('ready', { mode: 'docker' }, state => { state.ready = true; state.selectedMode = 'docker'; });
  }
  async run(command: string, signal?: AbortSignal, timeoutMs?: number): Promise<ProcessResult> {
    if (this.mode === 'filesystem') throw new EnvironmentUnavailable('Filesystem-only backend refuses project commands');
    if (this.mode === 'host') return runProcess('/bin/sh', ['-c', command], this.workspace, { signal, timeoutMs });
    return this.runSandbox(command, 'check', signal, timeoutMs);
  }
  private async runSandbox(command: string, purpose: 'check' | 'install', signal?: AbortSignal, timeoutMs?: number): Promise<ProcessResult> {
    const name = `harness-${this.taskId}-${purpose}-${this.state.resources.filter(item => item.purpose === purpose).length}`;
    const resource = this.resource(name, 'container', purpose);
    const git = await worktreeMetadata(this.workspace);
    const args = sandboxArgs(this.state.config, this.workspace, this.state.network, name, this.taskId, purpose, this.state.variables, git, purpose === 'install');
    try {
      const result = await this.driver.command([...args, this.state.config.image, '/bin/sh', '-c', command], signal, timeoutMs);
      if (result.code === 125) throw dockerFailure('container-startup-failed', 'run', `Docker could not start the ${purpose} sandbox: ${redact(result.output)}`, 'Inspect the retained command output, image compatibility, bind mounts and daemon resource limits. No workload ran; do not repair application code for this infrastructure failure.');
      return result;
    }
    finally { await this.remove(resource); }
  }
  private async health(resource: ManagedResource, signal?: AbortSignal): Promise<void> {
    let lastOutput = '';
    for (let attempt = 0; attempt < 30; attempt++) {
      signal?.throwIfAborted();
      const args = resource.purpose === 'postgres'
        ? ['exec', resource.name, 'sh', '-c', 'pg_isready -h 127.0.0.1 -U harness -d harness && psql -h 127.0.0.1 -U harness -d harness -tAc "SELECT 1"']
        : ['exec', resource.name, 'node', '-e', 'fetch("http://127.0.0.1:8080/__harness_health").then(async r=>{const b=await r.json();if(!r.ok||b.mock!==true)process.exit(1)}).catch(()=>process.exit(1))'];
      const result = await this.driver.command(args, signal, 5000);
      lastOutput = redact(result.output);
      if (result.code === 0 && !result.timedOut) {
        this.update('health.passed', { resource: resource.name, command: args.slice(2), exitCode: result.code, output: lastOutput }, () => {});
        return;
      }
      if (attempt < 29) await delay(200, undefined, { signal });
    }
    throw new EnvironmentUnavailable(`${resource.purpose} health check did not pass: ${lastOutput}`);
  }
  private async startService(purpose: 'postgres' | 'mock', signal?: AbortSignal): Promise<void> {
    const name = `harness-${this.taskId}-${purpose}`; const resource = this.resource(name, 'container', purpose);
    const existing = await inspectOwned(this.driver, this.taskId, resource, signal);
    if (existing && !existing.State?.Running) throw new EnvironmentUnavailable(`Service ${purpose} exists but is stopped; refusing to replace unknown data`);
    if (!existing) {
      const common = ['run', '-d', '--name', name, '--label', `harness.task=${this.taskId}`, '--label', `harness.purpose=${purpose}`,
        '--pull', this.state.config.allowImagePull ? 'missing' : 'never', '--network', this.state.network, '--network-alias', purpose,
        '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--memory=512m', '--cpus=1', '--pids-limit=128', '--tmpfs', '/tmp:rw,nosuid,nodev,size=64m,mode=1777'];
      if (purpose === 'postgres') {
        await this.command([...common, '--user', 'postgres', '--tmpfs', '/var/lib/postgresql/data:rw,nosuid,nodev,size=256m,mode=1777', '--tmpfs', '/var/run/postgresql:rw,nosuid,nodev,size=16m,mode=1777',
          '--env', 'PGDATA=/var/lib/postgresql/data/pgdata', '--env', 'POSTGRES_USER=harness', '--env', 'POSTGRES_DB=harness', '--env', 'POSTGRES_PASSWORD=local-disposable', '--env', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgres:16-bookworm'], signal);
      } else {
        const mock = this.state.config.services.mock!;
        const root = resolve(this.directory, 'environment'); await mkdir(root, { recursive: true });
        const serverPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../templates/mock-services/server.mjs');
        // Compiled code has an extra dist/ directory; resolve from the project root as a fallback.
        const server = await readFile(serverPath, 'utf8').catch(() => readFile(resolve(dirname(fileURLToPath(import.meta.url)), '../../../templates/mock-services/server.mjs'), 'utf8'));
        await writeFile(join(root, 'server.mjs'), server); await writeFile(join(root, 'routes.json'), JSON.stringify(mock.routes));
        if (root.includes(',')) throw new Error('Unsupported mock mount path');
        await this.command([...common, '--user', `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`, '--mount', `type=bind,src=${root},dst=/mock,readonly`, this.state.config.image, 'node', '/mock/server.mjs'], signal);
      }
    }
    await this.health(resource, signal); this.mark(resource.name, 'ready');
    this.update('dependency.verified', { name: purpose, kind: purpose === 'mock' ? 'mock' : 'real' }, state => {
      if (!state.dependencies.some(item => item.name === purpose)) state.dependencies.push({ name: purpose, kind: purpose === 'mock' ? 'mock' : 'real', verified: true });
      if (purpose === 'mock') state.limitations.push('Mock service contract verified locally; live external API integration remains unverified.');
    });
  }
  async recover(checks: CheckResult[], signal?: AbortSignal): Promise<'recovered' | 'blocked' | 'not-applicable'> {
    if (this.mode === 'filesystem') return 'not-applicable';
    const failures = await Promise.all(checks.filter(check => check.status === 'failed').map(async check => classifyFailure(await readFile(check.artifact, 'utf8'))));
    const failure = failures.find(item => item.kind !== 'unknown'); if (!failure) return 'not-applicable';
    if (this.mode === 'host' && failure.kind !== 'missing-dependency') return 'not-applicable';
    const fail = (reason: string) => { this.update('recovery.blocked', { kind: failure.kind, reason }, state => { state.limitations.push(reason); }); return 'blocked' as const; };
    if (this.state.activeRecovery !== undefined) return fail('An environment recovery has an unknown interrupted outcome; inspect managed resources before another attempt.');
    if (this.state.remainingRecoveryAttempts === 0 || this.state.recoveries.some(attempt => attempt.kind === failure.kind)) return fail(`Recovery budget exhausted or ${failure.kind} already attempted; refusing repeated unsuccessful recovery.`);
    if (failure.kind === 'postgres-unavailable' && !this.state.config.services.postgres) return fail('PostgreSQL was not declared or safely detected; no external database endpoint will be changed.');
    if (['missing-api-key', 'mock-unavailable'].includes(failure.kind) && !this.state.config.services.mock) return fail('External credentials unavailable and no explicit mock contract configured. Live integration remains unverified.');
    if (failure.kind === 'missing-dependency' && !this.state.config.allowDependencyInstall) return fail('Dependency installation needs explicit --allow-dependency-install network permission.');
    if (failure.kind === 'port-in-use' || failure.kind === 'browser-unavailable') return fail(`${failure.kind}: no verified automatic recovery is configured; use a task-specific port or a prebuilt browser image.`);
    const id = this.state.recoveries.length + 1; const artifact = join(this.directory, 'environment', `recovery-${id}.log`);
    const attempt: RecoveryAttempt = { id, kind: failure.kind, status: 'running', reason: redact(failure.reason), artifact };
    this.update('recovery.intent', attempt, state => { state.remainingRecoveryAttempts--; state.activeRecovery = id; state.recoveries.push(attempt); });
    let log = `${failure.kind}\n${redact(failure.reason)}\n`; let passed = false; let infrastructureError: EnvironmentUnavailable | undefined;
    try {
      if (failure.kind === 'postgres-unavailable') await this.startService('postgres', signal);
      else if (failure.kind === 'missing-api-key' || failure.kind === 'mock-unavailable') {
        await this.startService('mock', signal);
        const key = this.state.config.services.mock?.keyVariable;
        if (key) this.update('mock.credentials', { variable: key, placeholder: true }, state => { state.variables[key] = 'harness-mock-only'; });
      }
      else if (failure.kind === 'missing-env') {
        const content = [...new Set([...this.state.config.envKeys, ...Object.keys(this.state.variables)])].map(key => `${key}=${this.state.variables[key] ?? 'HARNESS_DEVELOPMENT_PLACEHOLDER'}`).join('\n') + '\n';
        if (content === '\n') throw new EnvironmentUnavailable('No environment example keys or disposable service variables are available');
        await writeFile(join(this.workspace, '.env'), content, { flag: 'wx', mode: 0o600 });
        if (await readFile(join(this.workspace, '.env'), 'utf8') !== content) throw new EnvironmentUnavailable('Generated development environment did not validate');
      } else if (failure.kind === 'missing-dependency') {
        const command = await installCommand(this.workspace); if (!command) throw new EnvironmentUnavailable('No supported frozen lockfile; dependency recovery cannot safely choose an install command');
        const result = this.mode === 'host'
          ? await runProcess('/bin/sh', ['-c', command], this.workspace, { signal, timeoutMs: 120_000 })
          : await this.runSandbox(command, 'install', signal, 120_000); log += result.output;
        if (result.code !== 0 || result.timedOut) throw new EnvironmentUnavailable('Frozen dependency installation failed');
      }
      passed = true; log += '\nRecovery action passed; rerunning required build and tests to verify application behavior.\n';
    } catch (error) { log += `\n${redact(String(error))}\n`; if (error instanceof EnvironmentUnavailable) infrastructureError = error; }
    await mkdir(dirname(artifact), { recursive: true }); await writeFile(artifact, redact(log));
    this.update('recovery.result', { id, passed, artifact }, state => {
      state.recoveries.find(item => item.id === id)!.status = passed ? 'passed' : 'failed'; delete state.activeRecovery;
      if (!passed) state.limitations.push(`Recovery ${failure.kind} failed; inspect ${artifact}`);
    });
    // Retain the failed recovery attempt, then propagate control-plane diagnostics
    // (including failures provisioning PostgreSQL), rather than masking them.
    if (infrastructureError) throw infrastructureError;
    return passed ? 'recovered' : 'blocked';
  }
  async cleanup(): Promise<void> {
    if (this.mode !== 'docker') return;
    for (const resource of [...this.state.resources].reverse()) if (resource.status !== 'removed') await this.remove(resource);
  }
  private async remove(resource: ManagedResource): Promise<void> {
    try {
      const found = await inspectOwned(this.driver, this.taskId, resource);
      if (found) await this.command(resource.kind === 'network' ? ['network', 'rm', resource.name] : ['container', 'rm', '--force', resource.name]);
      this.mark(resource.name, 'removed');
    } catch (error) {
      this.update('cleanup.error', { name: resource.name, error: redact(String(error)) }, state => { state.resources.find(item => item.name === resource.name)!.status = 'error'; state.cleanupErrors.push(`${resource.name}: ${redact(String(error))}`); });
    }
  }
}
