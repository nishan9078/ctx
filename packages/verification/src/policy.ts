import { access, readFile, lstat, realpath } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, sep, dirname } from 'node:path';
export type CheckName = 'build' | 'test' | 'typecheck' | 'security' | 'browser';
export type AcceptanceCriterion = { kind: 'directory' | 'file' | 'markdown'; path: string } | { kind: 'content'; path: string; content: string; match?: 'exact' | 'contains' };
export interface VerificationPolicy { plan?: import('./planner.js').VerificationPlan; kind: 'application' | 'filesystem' | 'documentation' | 'security'; required: CheckName[]; criteria: AcceptanceCriterion[]; description: string }
export function safeRelativePath(path: string): boolean {
  return !!path && !isAbsolute(path) && !path.includes('\\') && !/[\x00-\x1f]/.test(path) && !path.split('/').some(part => !part || part === '..' || part === '.' || ['.git', '.harness', 'node_modules'].includes(part));
}
export function validateAcceptance(value: unknown): AcceptanceCriterion[] {
  if (!Array.isArray(value) || !value.length || value.length > 50) throw new Error('Acceptance requires 1–50 filesystem criteria');
  return value.map(item => {
    if (!item || !['directory', 'file', 'content', 'markdown'].includes(item.kind) || typeof item.path !== 'string' || !safeRelativePath(item.path)) throw new Error('Acceptance paths must be safe relative workspace paths');
    if (item.kind === 'content') {
      if (typeof item.content !== 'string' || item.content.length > 100_000 || item.match !== undefined && !['exact', 'contains'].includes(item.match)) throw new Error('Invalid expected file content');
      return { kind: 'content', path: item.path, content: item.content, match: item.match ?? 'exact' };
    }
    return { kind: item.kind, path: item.path };
  });
}
export function inferAcceptance(request: string): AcceptanceCriterion[] | undefined {
  const simple = request.trim().replace(/[.!?]$/, '').replace(/^(?:hello[,!]?\s+)?(?:(?:can|could|would) you\s+)?(?:please\s+)?/i, '');
  const folder = simple.match(/^(?:create|make|add) (?:a |the )?(?:folder|directory)(?:\s+(?:(?:named|called|at)\s+)?["'`]?([\w./-]+)["'`]?)?$/i);
  if (folder) return validateAcceptance([{ kind: 'directory', path: folder[1] ?? 'new-folder' }]);
  const file = simple.match(/^(?:create|make|add|write) (?:a |the )?file\s+["'`]?([\w./-]+)["'`]?\s+(?:with (?:the )?(?:exact )?(?:content|contents)|containing)\s*:?\s*("(?:[^"\\]|\\.)*"|'[^']*')$/is);
  if (file) return validateAcceptance([{ kind: 'content', path: file[1], content: file[2].startsWith('"') ? JSON.parse(file[2]) : file[2].slice(1, -1) }]);
  const emptyFile = simple.match(/^(?:create|make|add) (?:a |the )?file(?:\s+(?:(?:named|called|at)\s+)?["'`]?([\w./-]+)["'`]?)?$/i);
  if (emptyFile) return validateAcceptance([{ kind: 'file', path: emptyFile[1] ?? 'new-file.txt' }]);
  const doc = simple.match(/^(?:update|edit)\s+([\w./-]+\.md)\s+to (?:include|contain)\s+("(?:[^"\\]|\\.)*"|'[^']*')$/is);
  if (doc) return validateAcceptance([{ kind: 'content', path: doc[1], content: doc[2].startsWith('"') ? JSON.parse(doc[2]) : doc[2].slice(1, -1), match: 'contains' }, { kind: 'markdown', path: doc[1] }]);
  return undefined;
}
export function createVerificationPolicy(request: string, commands: Partial<Record<CheckName, string>>, explicit?: unknown, forced: CheckName[] = []): VerificationPolicy {
  const criteria = explicit === undefined ? inferAcceptance(request) : validateAcceptance(explicit);
  const sensitive = /\b(?:auth|oauth|jwt|credentials|authentication|authorization|password|encryption|security[- ]sensitive|access control)\b/i.test(request);
  if (criteria && !sensitive) return { kind: criteria.some(item => item.kind === 'markdown') ? 'documentation' : 'filesystem', required: [...new Set(forced)], criteria, description: criteria.map(item => `${item.kind}: ${item.path}`).join('; ') };
  const required = (['build', 'test', 'typecheck'] as const).filter(name => !!commands[name]);
  for (const name of forced) if (!(required as CheckName[]).includes(name)) (required as CheckName[]).push(name);
  if (sensitive && !(required as CheckName[]).includes('security')) (required as CheckName[]).push('security');
  return { kind: sensitive ? 'security' : 'application', required, criteria: criteria ?? [], description: sensitive ? 'Application verification and required configured security checks' : 'Available application checks and required test command' };
}
async function containedPath(workspace: string, path: string): Promise<string> {
  if (!safeRelativePath(path)) throw new Error('Unsafe acceptance path');
  let current = workspace;
  for (const segment of path.split('/')) { current = join(current, segment); if ((await lstat(current)).isSymbolicLink()) throw new Error('Acceptance paths must not traverse symbolic links'); }
  const actual = await realpath(current); const rel = relative(await realpath(workspace), actual);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Acceptance path escapes workspace');
  return actual;
}
export async function verifyAcceptance(workspace: string, criteria: AcceptanceCriterion[]): Promise<{ passed: boolean; output: string }> {
  const results: string[] = []; let passed = true;
  for (const criterion of validateAcceptance(criteria)) {
    try {
      const path = await containedPath(workspace, criterion.path); const info = await lstat(path);
      if (criterion.kind === 'directory') { if (!info.isDirectory()) throw new Error('Expected directory'); }
      else {
        if (!info.isFile()) throw new Error('Expected regular file');
        if (criterion.kind === 'content') { const content = await readFile(path, 'utf8'); if (criterion.match === 'contains' ? !content.includes(criterion.content) : content !== criterion.content) throw new Error('Expected content did not match'); }
        if (criterion.kind === 'markdown') {
          const content = await readFile(path, 'utf8'); if (!content.trim()) throw new Error('Markdown is empty');
          for (const link of content.matchAll(/!?\[[^\]]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) {
            const target = link[1]; if (target.startsWith('#')) continue;
            if (/^https?:\/\//i.test(target)) { new URL(target); continue; }
            if (/^[a-z][\w+.-]*:/i.test(target)) { if (!target.startsWith('mailto:')) throw new Error('Unsupported link protocol'); continue; }
            const local = resolve(dirname(path), decodeURIComponent(target.split('#')[0]));
            const rel = relative(workspace, local); if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Local link leaves workspace');
            await access(local); const resolved = await realpath(local); const actualRelative = relative(await realpath(workspace), resolved); if (actualRelative === '..' || actualRelative.startsWith(`..${sep}`) || isAbsolute(actualRelative)) throw new Error('Local link resolves outside workspace');
          }
          results.push('External URLs checked for syntax only; network reachability is unverified.');
        }
      }
      results.push(`PASS ${criterion.kind}: ${criterion.path}`);
    } catch (error) { passed = false; results.push(`FAIL ${criterion.kind}: ${criterion.path}: ${(error as Error).message}`); }
  }
  return { passed, output: results.join('\n') + '\n' };
}
