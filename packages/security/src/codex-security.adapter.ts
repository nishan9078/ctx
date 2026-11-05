import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { runProcess } from '../../environment/src/process-manager.js';
import type { SecurityAdapter, SecurityResult } from './security-adapter.js';
export function securityWorkerPath(): string {
  const local = fileURLToPath(new URL('./worker.js', import.meta.url));
  return existsSync(local) ? local : fileURLToPath(new URL('../../../dist/packages/security/src/worker.js', import.meta.url));
}
export function securityEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const keys = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE']);
  return Object.fromEntries(Object.entries(source).filter(([key]) => keys.has(key) || /^(CODEX_|OPENAI_|OIC_)/.test(key)));
}
export class CodexSecurityAdapter implements SecurityAdapter {
  constructor(private readonly execute = runProcess, private readonly maxCostUsd = 1) {}
  async scan(input: Parameters<SecurityAdapter['scan']>[0]): Promise<SecurityResult> {
    let pending = '';
    try {
      const result = await this.execute(process.execPath, [securityWorkerPath(), input.repositoryPath, input.outputDirectory, String(this.maxCostUsd), input.changesOnly ? 'working-tree' : 'repository'], input.repositoryPath, {
        signal: input.signal, timeoutMs: 300_000, env: securityEnvironment(process.env),
        onOutput: chunk => {
          pending = (pending + chunk).slice(-100_000);
          let newline: number;
          while ((newline = pending.indexOf('\n')) >= 0) {
            const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
            if (line.startsWith('CTX_SECURITY_PROGRESS ')) try { const event = JSON.parse(line.slice(22)); if (typeof event.message === 'string') input.onProgress?.(event.message); } catch { /* Untrusted progress never establishes success. */ }
          }
        },
      });
      if (input.signal?.aborted) return { status: 'cancelled', findings: [], coverage: [], limitations: ['Scan cancelled.'] };
      if (result.timedOut || result.code !== 0) return { status: 'error', findings: [], coverage: [], limitations: [result.timedOut ? 'Security scan timed out; coverage is incomplete.' : 'Security worker failed to produce a completed result.'] };
      const report: SecurityResult = JSON.parse(await readFile(join(input.outputDirectory, 'security-result.json'), 'utf8'));
      if (!['passed', 'findings', 'unavailable', 'error', 'cancelled'].includes(report.status) || !Array.isArray(report.findings) || !Array.isArray(report.coverage) || !report.coverage.every(value => typeof value === 'string') || !Array.isArray(report.limitations) || !report.limitations.every(value => typeof value === 'string') || report.findings.some(finding => !finding || typeof finding.id !== 'string' || typeof finding.title !== 'string' || !['critical', 'high', 'medium', 'low', 'informational'].includes(finding.severity) || (finding.file !== undefined && typeof finding.file !== 'string') || (finding.line !== undefined && (!Number.isInteger(finding.line) || finding.line < 1))) || (report.status === 'passed' && report.findings.length !== 0)) throw new Error('Invalid security result');
      return report;
    } catch (error) { return { status: input.signal?.aborted ? 'cancelled' : 'unavailable', findings: [], coverage: [], limitations: [String(error)] }; }
  }
}
