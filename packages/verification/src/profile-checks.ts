import type { TreeEntry } from '../../environment/src/workspace-tree.js';
import type { TaskSpec } from '../../shared/src/domain.js';
import type { VerificationProfile } from '../../shared/src/verification-profile.js';
import type { BaselineScan } from '../../security/src/baseline-scanners.js';
export function pathMatches(path: string, pattern: string): boolean {
  if (!pattern.includes('*')) return path === pattern || path.startsWith(`${pattern}/`);
  if (pattern.endsWith('/**') && path === pattern.slice(0, -3)) return true;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0001').replace(/\*/g, '[^/]*').replace(/\u0001/g, '.*');
  return new RegExp(`^${escaped}$`).test(path);
}
export function changedTreePaths(baseline: TreeEntry[], current: TreeEntry[]): string[] {
  const before = new Map(baseline.map(entry => [entry.path, entry])); const after = new Map(current.map(entry => [entry.path, entry]));
  return [...new Set([...before.keys(), ...after.keys()])].filter(path => { const a = before.get(path); const b = after.get(path); return a?.kind !== b?.kind || a?.sha256 !== b?.sha256 || a?.mode !== b?.mode; }).sort();
}
export function scopeCheck(task: TaskSpec, profile: VerificationProfile, baseline: TreeEntry[], current: TreeEntry[]): BaselineScan {
  const changed = changedTreePaths(baseline, current);
  const unexpected = changed.filter(path => task.scope.exclude.some(pattern => pathMatches(path, pattern)) || ![...task.scope.include, ...profile.generatedPaths].some(pattern => pathMatches(path, pattern)) || profile.purpose !== 'code' && /\.(?:[cm]?[jt]sx?|py|go|rs|java|c|cpp)$/i.test(path));
  return { status: unexpected.length ? 'failed' : 'passed', findings: unexpected.map((path, index) => ({ id: `scope-${index}`, scanner: 'ctx-scope', severity: 'high', message: 'Change is outside the immutable task/profile scope', path })), output: JSON.stringify({ changed, unexpected }, null, 2), limitations: ['Scope is evaluated against the full captured tree, including ignored files; generated paths must be explicitly approved by the profile.'] };
}
const isTest = (path: string) => /(?:^|\/)tests?\.[cm]?[jt]sx?$|(?:^|\/)(?:tests?\/|__tests__\/)|(?:\.test|\.spec)\.[cm]?[jt]sx?$|(?:^|\/)test_.*\.py$/i.test(path);
export function testIntegrityCheck(profile: VerificationProfile, baseline: TreeEntry[], current: TreeEntry[]): BaselineScan {
  const after = new Map(current.map(entry => [entry.path, entry])); const findings: BaselineScan['findings'] = [];
  for (const original of baseline.filter(entry => entry.kind === 'file')) {
    const now = after.get(original.path); const protectedFile = isTest(original.path) || profile.protectedPaths.some(pattern => pathMatches(original.path, pattern));
    if (protectedFile && (original.sha256 !== now?.sha256 || original.mode !== now?.mode)) findings.push({ id: `integrity-${findings.length}`, scanner: 'ctx-test-integrity', severity: 'high', message: 'An existing test or owner-protected input changed or disappeared', path: original.path });
    if (original.path === 'package.json') {
      try {
        const before = JSON.parse(Buffer.from(original.content!, 'base64').toString('utf8')); const currentPackage = now && JSON.parse(Buffer.from(now.content!, 'base64').toString('utf8'));
        if (!currentPackage || JSON.stringify(before.scripts ?? {}) !== JSON.stringify(currentPackage.scripts ?? {})) findings.push({ id: 'scripts-changed', scanner: 'ctx-test-integrity', severity: 'high', message: 'Package scripts changed after the profile was bound', path: original.path });
      } catch { findings.push({ id: 'scripts-invalid', scanner: 'ctx-test-integrity', severity: 'high', message: 'Package script metadata is invalid', path: original.path }); }
    }
  }
  for (const entry of current.filter(entry => entry.kind === 'file' && isTest(entry.path))) {
    const source = Buffer.from(entry.content!, 'base64').toString('utf8');
    if (/\b(?:test|it|describe)\.(?:skip|only|todo)\s*\(|\b(?:xit|xdescribe)\s*\(|@pytest\.mark\.(?:skip|skipif|xfail)\b/.test(source)) findings.push({ id: `omission-${findings.length}`, scanner: 'ctx-test-integrity', severity: 'high', message: 'Test omission or selection marker detected', path: entry.path });
  }
  return { status: findings.length ? 'failed' : 'passed', findings, output: `Checked existing test/protected-file hashes, package scripts and common test omission markers. Findings: ${findings.length}.\n`, limitations: ['Existing tests/protected files must remain unchanged; new tests may be added. Marker detection and parsed test summaries are not a proof of complete semantic coverage.'] };
}
export { verifyTestSummary } from '../../shared/src/test-evidence.js';
