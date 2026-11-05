import type { DockerDriver } from '../../packages/environment/src/types.js';
import type { ProcessResult } from '../../packages/environment/src/process-manager.js';
export class FakeDocker implements DockerDriver {
  readonly kind = 'simulated' as const;
  readonly calls: string[][] = [];
  readonly resources = new Map<string, { kind: string; purpose: string; task: string; running: boolean }>();
  healthFails = false; available = true; imagesAvailable = true;
  failures: string[] = ['DATABASE_URL PostgreSQL ECONNREFUSED postgres:5432'];
  async command(args: string[]): Promise<ProcessResult> {
    this.calls.push(args);
    const result = (code = 0, output = '') => ({ code, output, timedOut: false, truncated: false });
    const value = (key: string) => args[args.indexOf(key) + 1];
    if (!this.available) return result(1, 'permission denied on Docker socket');
    if (args[0] === 'info') return result(0, '29.0');
    if (args[0] === 'image') return result(this.imagesAvailable ? 0 : 1, this.imagesAvailable ? 'image inspection' : `No such image: ${args[2]}`);
    if (args[0] === 'pull') { this.imagesAvailable = true; return result(0, 'image pulled'); }
    if (args[1] === 'inspect') {
      const resource = this.resources.get(args[2]);
      if (!resource) return result(1, `No such ${args[0]}: ${args[2]}`);
      const labels = { 'harness.task': resource.task, 'harness.purpose': resource.purpose };
      return result(0, JSON.stringify([resource.kind === 'network' ? { Labels: labels, Internal: true } : { Config: { Labels: labels }, State: { Running: resource.running } }]));
    }
    if (args[0] === 'network' && args[1] === 'create') {
      const task = args.find(item => item.startsWith('harness.task='))!.split('=')[1]; this.resources.set(args.at(-1)!, { kind: 'network', purpose: 'sandbox', task, running: true }); return result(0, 'network-id');
    }
    if ((args[0] === 'network' || args[0] === 'container') && args[1] === 'rm') { this.resources.delete(args.at(-1)!); return result(); }
    if (args[0] === 'exec') return result(this.healthFails ? 1 : 0, this.healthFails ? 'not ready' : '1');
    if (args[0] === 'run') {
      const task = args.find(item => item.startsWith('harness.task='))!.split('=')[1]; const purpose = args.find(item => item.startsWith('harness.purpose='))!.split('=')[1];
      this.resources.set(value('--name'), { kind: 'container', purpose, task, running: purpose === 'postgres' || purpose === 'mock' });
      if (args.includes('-d')) return result(0, 'container-id');
      if (purpose === 'install') return result(0, 'Dependencies installed with frozen lockfile');
      if (args.at(-1)!.includes('test') && this.failures.length) return result(1, this.failures.shift()!);
      return result(0, 'Checks passed\n# pass 1\n');
    }
    return result(1, `Unsupported fake Docker command: ${args.join(' ')}`);
  }
}
