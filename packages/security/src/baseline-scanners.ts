import { createHash } from 'node:crypto';
import type { TreeEntry } from '../../environment/src/workspace-tree.js';
import type { GateFinding, GateStep } from '../../shared/src/verification-profile.js';
export interface BaselineScan { status: 'passed' | 'failed' | 'unavailable'; findings: GateFinding[]; output: string; limitations: string[] }
const fingerprint = (value: string) => createHash('sha256').update(value).digest('hex');
export function scanSecrets(entries: TreeEntry[], env: NodeJS.ProcessEnv = process.env): BaselineScan {
  const findings: GateFinding[] = []; let scanned = 0;
  const known = Object.entries(env).filter(([key, value]) => /TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY/i.test(key) && value && value.length >= 8).map(([, value]) => value!);
  for (const entry of entries) {
    if (entry.kind !== 'file') continue; scanned++;
    const content = Buffer.from(entry.content ?? '', 'base64').toString('utf8');
    const matches = [...content.matchAll(/\bsk-[A-Za-z0-9_-]{16,}\b|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g)].map(match => ({ index: match.index!, value: match[0] }));
    for (const value of known) { const index = content.indexOf(value); if (index >= 0) matches.push({ index, value }); }
    const seen = new Set<string>();
    for (const match of matches) {
      const hash = fingerprint(match.value); if (seen.has(hash)) continue; seen.add(hash);
      if (findings.length >= 500) break;
      findings.push({ id: `secret-${findings.length + 1}`, scanner: 'ctx-secret-baseline', severity: 'high', message: 'Suspicious credential material; value omitted', path: entry.path, line: content.slice(0, match.index).split('\n').length, fingerprint: hash });
    }
  }
  return { status: findings.length ? 'failed' : 'passed', findings, output: `Scanned ${scanned} files for known credential values and recognized credential/private-key patterns. Findings: ${findings.length}. Values are never included in findings.\n`, limitations: ['Pattern and known-environment-value detection only; not a complete secret scanner. Exact binary evidence remains private and is not redacted.'] };
}
export function scanDependencies(entries: TreeEntry[], advisory: GateStep['advisories']): BaselineScan {
  const empty = (status: BaselineScan['status'], output: string, findings: GateFinding[] = []): BaselineScan => ({ status, output: output + '\n', findings, limitations: ['Dependency coverage is limited to npm lock versions and an explicitly supplied exact-version advisory snapshot; no network query or installation is performed.'] });
  const files = new Map(entries.filter(entry => entry.kind === 'file').map(entry => [entry.path, entry]));
  const read = (path: string) => JSON.parse(Buffer.from(files.get(path)!.content!, 'base64').toString('utf8')) as Record<string, unknown>;
  const nestedOrOther = [...files.keys()].some(path => path !== 'package.json' && /(?:^|\/)(?:package\.json|requirements.*\.txt|pyproject\.toml|Cargo\.lock|go\.mod|pnpm-lock\.yaml|yarn\.lock)$/.test(path));
  if (!files.has('package.json')) return empty(nestedOrOther ? 'unavailable' : 'passed', 'No supported npm manifest; other dependency ecosystems require an explicitly configured scanner command.');
  let manifest: Record<string, unknown>;
  try { manifest = read('package.json'); } catch { return empty('failed', 'Malformed package.json'); }
  for (const key of ['dependencies','devDependencies','optionalDependencies','peerDependencies']) if (manifest[key] !== undefined && (typeof manifest[key] !== 'object' || manifest[key] === null || Array.isArray(manifest[key]))) return empty('failed', 'Malformed dependency declarations');
  const declared = ['dependencies','devDependencies','optionalDependencies','peerDependencies'].flatMap(key => Object.keys(manifest[key] as object ?? {}));
  if (nestedOrOther) return empty('unavailable', 'Nested or other-ecosystem dependency manifests require an explicitly configured scanner command.');
  if (!declared.length) return empty('passed', 'Parsed npm manifest: no package dependencies are declared.');
  if (!files.has('package-lock.json') || !advisory) return empty('unavailable', 'Dependencies exist but a supported lockfile and approved advisory snapshot are not both available.');
  let lock: { packages?: Record<string, { name?: string; version?: string }> };
  try { lock = read('package-lock.json'); } catch { return empty('failed', 'Malformed package-lock.json'); }
  if (!lock.packages) return empty('unavailable', 'Only npm lockfile package records are currently supported.');
  const packages = Object.entries(lock.packages).filter(([path]) => path.includes('node_modules/')).map(([path, value]) => ({ name: value.name ?? path.slice(path.lastIndexOf('node_modules/') + 13), version: value.version }));
  if (!packages.length || declared.some(name => !packages.some(pkg => pkg.name === name)) || packages.some(pkg => !pkg.version || !/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(pkg.version))) return empty('unavailable', 'Declared dependency versions cannot be established from the supported lockfile.');
  const findings: GateFinding[] = [];
  for (const pkg of packages) for (const item of advisory.entries) if (item.name === pkg.name && item.version === pkg.version) findings.push({ id: item.id, scanner: 'ctx-local-advisories', severity: item.severity, message: `Approved advisory snapshot matches ${pkg.name}@${pkg.version}`, path: 'package-lock.json' });
  return empty(findings.length ? 'failed' : 'passed', `Compared ${packages.length} locked package versions with owner-approved advisory snapshot ${advisory.source} (${advisory.asOf}). Findings: ${findings.length}.`, findings);
}
