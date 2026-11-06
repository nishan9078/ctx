import { readdir, readFile, lstat } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { createVerificationPolicy, type AcceptanceCriterion, type CheckName } from './policy.js';
import type { ProjectKind, Requirement, PlannedCheck, VerificationPlan } from '../../shared/src/verification.js';
export type { ProjectKind, Requirement, PlannedCheck, VerificationPlan } from '../../shared/src/verification.js';
const ignored = new Set(['.git', '.harness', 'node_modules', 'dist', 'build', '.next', 'coverage', '.venv', 'vendor']);
export async function projectFiles(root: string): Promise<string[]> {
  const paths: string[] = [];
  async function visit(directory: string, prefix: string, depth: number): Promise<void> {
    if (depth > 6) return;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (paths.length >= 5000) throw new Error('Project discovery exceeds 5000 files; configure explicit verification for this workspace');
      if (ignored.has(entry.name) || entry.isSymbolicLink()) continue;
      const path = prefix + entry.name;
      if (entry.isDirectory()) await visit(join(directory, entry.name), path + '/', depth + 1);
      else if (entry.isFile()) paths.push(path);
    }
  }
  await visit(root, '', 0); return paths.sort();
}
async function manifest(root: string): Promise<Record<string, any>> {
  try { return JSON.parse(await readFile(join(root, 'package.json'), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error; }
}
function detect(files: string[], pkg: Record<string, any>, request: string): ProjectKind[] {
  const kinds = new Set<ProjectKind>();
  if (files.some(path => /\.html?$/i.test(path)) || /\bhtml\b|\.html?\b/i.test(request)) kinds.add('static-html');
  if (files.some(path => /\.[cm]?jsx?$/i.test(path)) || pkg.name || pkg.scripts) kinds.add('javascript');
  if (files.some(path => /\.[cm]?tsx?$/i.test(path)) || files.some(path => /(?:^|\/)tsconfig[^/]*\.json$/.test(path))) kinds.add('typescript');
  if (files.some(path => /(?:^|\/)(?:pyproject.toml|requirements.txt|go.mod|Cargo.toml|pom.xml|build.gradle|Gemfile)$/.test(path)) || ['express', 'fastify', '@nestjs/core', 'koa'].some(name => pkg.dependencies?.[name])) kinds.add('backend');
  if (files.some(path => /\.(md|mdx|rst|txt)$/i.test(path))) kinds.add('documentation');
  if (!kinds.size) kinds.add('unknown');
  if ([...kinds].filter(kind => kind !== 'documentation').length > 1) kinds.add('mixed');
  return [...kinds];
}
function runnerCommand(files: string[], pkg: Record<string, any>): string | undefined {
  const dependencies = { ...pkg.dependencies, ...pkg.devDependencies };
  if (dependencies.vitest || files.some(path => /(?:^|\/)vitest.config\./.test(path))) return 'node node_modules/vitest/vitest.mjs run';
  if (dependencies.jest || files.some(path => /(?:^|\/)jest.config\./.test(path))) return 'node node_modules/jest/bin/jest.js --runInBand';
  if (files.some(path => /(?:^|\/)[^/]+\.(?:test|spec)\.[cm]?js$/.test(path))) return 'node --test';
  return undefined;
}
export async function planVerification(input: {
  root: string; request: string; commands: Partial<Record<CheckName, string>>; forced: CheckName[];
  criteria: AcceptanceCriterion[]; changedFiles?: string[]; deletedFiles?: string[]; initial?: VerificationPlan;
}): Promise<VerificationPlan> {
  const files = await projectFiles(input.root); const pkg = await manifest(input.root); const projects = detect(files, pkg, input.request);
  const resolved = input.changedFiles !== undefined;
  const changes = input.changedFiles ?? [];
  const targeted = (resolved ? changes : files).filter(path => !input.deletedFiles?.includes(path));
  const checkMap = new Map<string, PlannedCheck>();
  const put = (check: PlannedCheck) => { const old = checkMap.get(check.id); if (old?.requirement === 'mandatory') return; checkMap.set(check.id, check); };
  // Initial mandatory commands are never removed by changes to package.json.
  for (const check of input.initial?.checks ?? []) if (check.kind === 'command' || check.kind === 'browser') put(structuredClone(check));
  const structuralOnly = input.criteria.length > 0 && !/\b(?:auth|oauth|jwt|credentials|authentication|authorization|password|encryption|security[- ]sensitive|access control)\b/i.test(input.request);
  for (const name of ['build', 'test', 'typecheck', 'security', 'browser'] as const) {
    const forced = input.forced.includes(name);
    let command = input.commands[name];
    if (!command && resolved && typeof pkg.scripts?.[name] === 'string') command = name === 'test' ? 'npm test' : `npm run ${name}`;
    if (!command && name === 'test' && !structuralOnly && !forced) command = runnerCommand(files, pkg);
    if (!command && name === 'browser' && !forced) command = typeof pkg.scripts?.['test:browser'] === 'string' ? 'npm run test:browser' : typeof pkg.scripts?.['test:e2e'] === 'string' ? 'npm run test:e2e' : undefined;
    const securityRequired = name === 'security' && /\b(?:auth|oauth|jwt|credentials|authentication|authorization|password|encryption|security[- ]sensitive|access control)\b/i.test(input.request);
    put({ id: name, kind: name === 'browser' ? 'browser' : 'command', requirement: forced || securityRequired || command && !structuralOnly && name !== 'browser' ? 'mandatory' : name === 'browser' ? 'optional' : 'not-applicable', command,
      paths: [], reason: forced ? 'Explicitly configured by the user; must pass' : securityRequired ? 'Security-sensitive request requires a configured security check' : structuralOnly && command ? 'Not applicable to this filesystem/documentation-only task; no project command executed' : command ? 'Existing project verification command or test runner' : name === 'browser' ? 'Browser smoke coverage is separate from syntax; attempt only when a browser and approved backend are available' : `No corresponding ${name} system configured; no command invented` });
  }
  if (input.criteria.length) put({ id: 'acceptance', kind: 'acceptance', requirement: 'mandatory', reason: 'Deterministic task-specific filesystem criteria', paths: input.criteria.map(item => item.path) });
  const expectedHtml = /\bhtml\b|\.html?\b/i.test(input.request) ? [...input.request.matchAll(/\b([\w./-]+\.html?)\b/gi)].map(match => match[1]) : [];
  if (projects.includes('static-html') && !expectedHtml.length && !files.some(path => /\.html?$/i.test(path))) expectedHtml.push('index.html');
  const html = [...new Set([...targeted.filter(path => /\.html?$/i.test(path)), ...expectedHtml])];
  const code = targeted.filter(path => /\.(?:[cm]?[jt]sx?|py)$/i.test(path));
  const docs = targeted.filter(path => /\.md$/i.test(path));
  if (html.length || code.length) {
    put({ id: 'artifacts', kind: 'artifacts', requirement: 'mandatory', reason: 'Generated or modified code artifacts must exist and be nonempty', paths: [...new Set([...html, ...code])] });
    put({ id: 'syntax', kind: 'syntax', requirement: 'mandatory', reason: 'Independent syntax parsing; does not execute application code or prove gameplay/browser behavior', paths: [...new Set([...html, ...code])] });
  }
  if (docs.length && !input.criteria.some(item => item.kind === 'markdown')) put({ id: 'documentation', kind: 'documentation', requirement: 'mandatory', reason: 'Changed Markdown content and local link targets', paths: docs });
  if (!html.length && !projects.includes('static-html') && !checkMap.get('browser')?.command && !input.forced.includes('browser')) put({ id: 'browser', kind: 'browser', requirement: 'not-applicable', reason: 'No HTML/browser surface or browser command detected', paths: [] });
  else { const browser = checkMap.get('browser')!; browser.paths = html.filter(path => /\.html?$/i.test(path)); }
  if (!checkMap.has('acceptance') && ![...checkMap.values()].some(check => check.requirement === 'mandatory')) {
    put({ id: 'artifacts', kind: 'artifacts', requirement: 'mandatory', reason: resolved ? 'No runnable test system; verify independently recorded changed artifacts instead of trusting an agent claim' : 'Defer artifact selection until the actual changed files are known', paths: targeted, absentPaths: input.deletedFiles });
  }
  const limitations = ['Agent-reported test results are not independent verification evidence.', 'Syntax checks do not establish runtime, visual, gameplay, or security correctness.'];
  if (!checkMap.get('test')?.command) limitations.push('No configured automated test runner was found; functional behavior beyond the recorded checks is unverified.');
  if (projects.includes('backend') && ![...checkMap.values()].some(check => check.kind === 'command' && check.requirement === 'mandatory')) limitations.push('Backend project detected without a configured runnable test system; structural checks do not prove API or service behavior.');
  if (html.length) limitations.push('Browser coverage is reported separately; unavailable optional browser testing does not imply a browser pass.');
  return { version: 1, phase: resolved ? 'resolved' : 'initial', projects: structuralOnly ? [...projects.filter(kind => kind !== 'unknown'), 'filesystem'] : projects, checks: [...checkMap.values()], changedFiles: changes, limitations };
}
export async function initialVerification(root: string, request: string, commands: Partial<Record<CheckName, string>>, explicit?: unknown, forced: CheckName[] = []) {
  const policy = createVerificationPolicy(request, commands, explicit, forced);
  const plan = await planVerification({ root, request, commands, forced, criteria: policy.criteria });
  policy.required = plan.checks.filter(check => check.kind === 'command' && check.requirement === 'mandatory').map(check => check.id as CheckName);
  policy.plan = plan;
  policy.description = plan.checks.filter(check => check.requirement === 'mandatory').map(check => `${check.id}: ${check.reason}`).join('; ');
  return policy;
}
export function commandChecksRequired(plan: VerificationPlan): boolean { return plan.checks.some(check => check.requirement === 'mandatory' && (check.kind === 'command' || check.kind === 'browser') && !!check.command); }
