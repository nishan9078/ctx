import { CodexSecurity, DiffTarget } from '@openai/codex-security';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import type { SecurityResult } from './security-adapter.js';
import { redact } from '../../shared/src/redact.js';
if (process.argv[2] === '--check') { console.log('Security engine ready'); process.exit(0); }
const [repository, output, budget, target] = process.argv.slice(2);
if (!repository || !output) throw new Error('Repository and output directory are required');
const rel = relative(resolve(repository), resolve(output));
if (!rel || (rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel))) throw new Error('Security results must be outside the scanned repository');
await mkdir(output, { recursive: true, mode: 0o700 });
const maxCostUsd = Number(budget ?? 1);
if (!Number.isFinite(maxCostUsd) || maxCostUsd <= 0 || maxCostUsd > 100) throw new Error('Invalid scan budget');
const security = new CodexSecurity({ codexOverrides: { approval_policy: 'never', sandbox_mode: 'read-only' } });
let result: SecurityResult;
try {
  const scan = await security.run(repository, {
    mode: 'standard', target: target === 'working-tree' ? DiffTarget.workingTree({ base: 'HEAD' }) : undefined, outputDir: output, maxCostUsd, maxTimeMinutes: 3, ownerSuggestions: false,
    onProgress: progress => process.stdout.write(`CTX_SECURITY_PROGRESS ${JSON.stringify({ message: 'Reviewing source', completed: progress.filesCompleted, total: progress.filesTotal })}\n`),
    onScanStarted: () => process.stdout.write('CTX_SECURITY_PROGRESS {"message":"Reviewing source"}\n'),
  });
  if (scan.manifest.scan.status !== 'completed') throw new Error('Security scan did not complete');
  const findings = scan.findings.findings.map(finding => {
    if (!finding.findingId || !finding.title || !['critical', 'high', 'medium', 'low', 'informational'].includes(finding.severity.level)) throw new Error('Invalid security finding');
    return { id: finding.findingId, title: finding.title, severity: finding.severity.level, file: finding.locations[0]?.path, line: finding.locations[0]?.startLine };
  });
  const coverage = scan.manifest.scan.scope.artifactsReviewed ?? [];
  result = { status: findings.length ? 'findings' : 'passed', findings, coverage, reportPath: scan.reportPath,
    limitations: [...(scan.manifest.scan.warnings ?? []), ...(scan.manifest.scan.scope.limitations ?? []), ...(coverage.length ? [] : ['File-level reviewed coverage was not supplied.']), 'This scan does not replace application tests or verify production integrations.'] };
} catch (error) {
  const message = redact(String(error));
  result = { status: /Authentication|PythonUnavailable|authentication|sign.in|trusted.access|unauthorized|API.key|ENOENT|not.found/i.test(message) ? 'unavailable' : 'error', findings: [], coverage: [], limitations: [message] };
} finally { await security.close(); }
await writeFile(join(output, 'security-result.json'), redact(JSON.stringify(result, null, 2)) + '\n', { mode: 0o600 });
