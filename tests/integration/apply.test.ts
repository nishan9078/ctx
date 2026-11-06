import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, symlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { runTask, databasePath } from '../../packages/core/src/orchestrator.js';
import { previewApply, confirmApply } from '../../packages/core/src/apply.js';
import { runProcess } from '../../packages/environment/src/process-manager.js';
async function fixture(work: (source: string, output: string, keep: (path: string) => void) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'ctx-apply-')); const source = join(root, 'source'); await mkdir(source); const workspaces = new Set<string>();
  try { await work(source, join(root, 'runs'), path => workspaces.add(path)); } finally { for (const path of workspaces) await rm(dirname(path), { recursive: true, force: true }); await rm(root, { recursive: true, force: true }); }
}
async function git(source: string, args: string[]) { const result = await runProcess('git', args, source); assert.equal(result.code, 0, result.output); return result.output; }
async function baseline(source: string) {
  await writeFile(join(source, '.gitignore'), '.harness/\n'); await writeFile(join(source, 'note.txt'), 'original');
  await git(source, ['init', '-q']); await git(source, ['add', '.']); await git(source, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'baseline']);
}
test('apply previews and confirms verified HTML and empty directories without staging or changing unrelated dirty work', async () => fixture(async (source, output, keep) => {
  await baseline(source);
  const result = await runTask({ request: 'Create standalone index.html', repositoryPath: source, outputDirectory: output, acceptance: [{ kind: 'directory', path: 'assets' }, { kind: 'file', path: 'index.html' }], environment: { mode: 'auto' } }, { async execute(input) { keep(input.workspacePath); await mkdir(join(input.workspacePath, 'assets')); await writeFile(join(input.workspacePath, 'index.html'), '<html><body><script>const game=1;</script></body></html>'); return { outcome: 'completed', summary: 'Done' }; } });
  assert.equal(result.report.outcome, 'completed', JSON.stringify(result.report)); await writeFile(join(source, 'note.txt'), 'unrelated dirty work');
  const preview = await previewApply(databasePath(output), result.report.id, source); assert.deepEqual(preview.conflicts, []); assert.ok(preview.token); await assert.rejects(stat(join(source, 'index.html')));
  await assert.rejects(confirmApply(databasePath(output), result.report.id, source, 'wrong-token'), /expired or changed/);
  const applied = await confirmApply(databasePath(output), result.report.id, source, preview.token!); assert.equal(applied.status, 'applied'); assert.ok((await stat(join(source, 'assets'))).isDirectory()); assert.match(await readFile(join(source, 'index.html'), 'utf8'), /const game/);
  assert.equal(await readFile(join(source, 'note.txt'), 'utf8'), 'unrelated dirty work'); assert.equal(await git(source, ['diff', '--cached', '--name-only']), '');
  await assert.rejects(confirmApply(databasePath(output), result.report.id, source, preview.token!));
}));
test('apply refuses initial dirty/staged work, subsequent edits, and new-file collisions', async () => fixture(async (source, output, keep) => {
  await baseline(source); await writeFile(join(source, 'note.txt'), 'initial dirty');
  const result = await runTask({ request: 'Create file note.txt with content "verified"', repositoryPath: source, outputDirectory: output, environment: { mode: 'auto' } }, { async execute(input) { keep(input.workspacePath); await writeFile(join(input.workspacePath, 'note.txt'), 'verified'); return { outcome: 'completed', summary: 'Done' }; } });
  const dirty = await previewApply(databasePath(output), result.report.id, source); assert.ok(dirty.conflicts.some(item => /Git paths|staged/.test(item))); assert.equal(dirty.token, undefined);
  await writeFile(join(source, 'note.txt'), 'concurrent user edit'); const edited = await previewApply(databasePath(output), result.report.id, source); assert.ok(edited.conflicts.length); assert.equal(await readFile(join(source, 'note.txt'), 'utf8'), 'concurrent user edit');
}));
test('confirmation rechecks the target, evidence and verified worktree', async () => fixture(async (source, output, keep) => {
  const result = await runTask({ request: 'Create file result.txt with content "verified"', repositoryPath: source, outputDirectory: output, environment: { mode: 'auto' } }, { async execute(input) { keep(input.workspacePath); await writeFile(join(input.workspacePath, 'result.txt'), 'verified'); return { outcome: 'completed', summary: 'Done' }; } });
  const preview = await previewApply(databasePath(output), result.report.id, source);
  await writeFile(join(source, 'result.txt'), 'new user file'); await assert.rejects(confirmApply(databasePath(output), result.report.id, source, preview.token!), /conflict/); assert.equal(await readFile(join(source, 'result.txt'), 'utf8'), 'new user file');
  await rm(join(source, 'result.txt')); await writeFile(join(result.report.workspacePath!, 'result.txt'), 'tampered'); await assert.rejects(previewApply(databasePath(output), result.report.id, source), /changed after verification/);
  await writeFile(join(result.report.workspacePath!, 'result.txt'), 'verified'); await writeFile(result.report.verification.find(check => check.name === 'acceptance')!.artifact, 'tampered evidence'); await assert.rejects(previewApply(databasePath(output), result.report.id, source), /evidence missing or changed/);
}));
test('apply refuses symlink parent escapes and failed tasks', async () => fixture(async (source, output, keep) => {
  const result = await runTask({ request: 'Create file nested/result.txt with content "verified"', repositoryPath: source, outputDirectory: output, environment: { mode: 'auto' } }, { async execute(input) { keep(input.workspacePath); await mkdir(join(input.workspacePath, 'nested')); await writeFile(join(input.workspacePath, 'nested/result.txt'), 'verified'); return { outcome: 'completed', summary: 'Done' }; } });
  const outside = join(dirname(source), 'outside'); await mkdir(outside); await symlink(outside, join(source, 'nested'));
  const preview = await previewApply(databasePath(output), result.report.id, source); assert.ok(preview.conflicts.length); await assert.rejects(stat(join(outside, 'result.txt')));
  const failed = await runTask({ request: 'Create folder absent', repositoryPath: source, outputDirectory: join(output, 'failed'), signal: AbortSignal.abort(), environment: { mode: 'auto' } }, { async execute() { throw new Error('Must not start'); } });
  await assert.rejects(previewApply(databasePath(join(output, 'failed')), failed.report.id, source), /requires a completed task/);
}));

test('clean tracked changes and deletions apply with retained original backups', async () => fixture(async (source, output, keep) => {
  await baseline(source); await writeFile(join(source, 'obsolete.txt'), 'remove me'); await git(source, ['add', 'obsolete.txt']); await git(source, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'second baseline']);
  const result = await runTask({ request: 'Create file note.txt with content "updated"', repositoryPath: source, outputDirectory: output, environment: { mode: 'auto' } }, { async execute(input) { keep(input.workspacePath); await writeFile(join(input.workspacePath, 'note.txt'), 'updated'); await rm(join(input.workspacePath, 'obsolete.txt')); return { outcome: 'completed', summary: 'Done' }; } });
  const preview = await previewApply(databasePath(output), result.report.id, source); assert.deepEqual(preview.conflicts, []);
  const applied = await confirmApply(databasePath(output), result.report.id, source, preview.token!);
  assert.equal(await readFile(join(source, 'note.txt'), 'utf8'), 'updated'); await assert.rejects(stat(join(source, 'obsolete.txt')));
  assert.equal(await readFile(join(applied.backup, 'original/note.txt'), 'utf8'), 'original'); assert.equal(await readFile(join(applied.backup, 'original/obsolete.txt'), 'utf8'), 'remove me'); assert.equal(await git(source, ['diff', '--cached', '--name-only']), '');
}));
test('partial apply rolls back on failure; concurrent edits are preserved with a recovery journal', async () => fixture(async (source, output, keep) => {
  await baseline(source);
  const result = await runTask({ request: 'Create files', acceptance: [{ kind: 'content', path: 'note.txt', content: 'updated' }, { kind: 'file', path: 'z.txt' }], repositoryPath: source, outputDirectory: output, environment: { mode: 'auto' } }, { async execute(input) { keep(input.workspacePath); await writeFile(join(input.workspacePath, 'note.txt'), 'updated'); await writeFile(join(input.workspacePath, 'z.txt'), 'new'); return { outcome: 'completed', summary: 'Done' }; } });
  let preview = await previewApply(databasePath(output), result.report.id, source);
  await assert.rejects(confirmApply(databasePath(output), result.report.id, source, preview.token!, { beforeTransfer(_path, index) { if (index === 1) throw new Error('Injected transfer failure'); } }), /rolled-back/);
  assert.equal(await readFile(join(source, 'note.txt'), 'utf8'), 'original'); await assert.rejects(stat(join(source, 'z.txt')));
  preview = await previewApply(databasePath(output), result.report.id, source);
  await assert.rejects(confirmApply(databasePath(output), result.report.id, source, preview.token!, { async beforeTransfer(_path, index) { if (index === 1) { await writeFile(join(source, 'note.txt'), 'concurrent editor'); throw new Error('Injected failure with concurrent edit'); } } }), /needs-manual-recovery/);
  assert.equal(await readFile(join(source, 'note.txt'), 'utf8'), 'concurrent editor'); assert.ok((await stat(join(source, '.harness/apply.lock'))).isFile());
  await assert.rejects(confirmApply(databasePath(output), result.report.id, source, preview.token!), /lock exists/);
}));

test('verified ignored HTML is present in the apply manifest even when Git has no file diff', async () => fixture(async (source, output, keep) => {
  await baseline(source); await writeFile(join(source, '.gitignore'), '.harness/\nindex.html\n'); await git(source, ['add', '.gitignore']); await git(source, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'ignore html']);
  const result = await runTask({ request: 'Build standalone index.html', repositoryPath: source, outputDirectory: output, environment: { mode: 'auto' } }, { async execute(input) { keep(input.workspacePath); await writeFile(join(input.workspacePath, 'index.html'), '<html><script>const game=1;</script></html>'); return { outcome: 'completed', summary: 'Done' }; } });
  assert.equal(result.report.outcome, 'completed'); assert.equal(result.report.implemented.hasChanges, true);
  const preview = await previewApply(databasePath(output), result.report.id, source); assert.ok(preview.entries.some(entry => entry.path === 'index.html')); assert.deepEqual(preview.conflicts, []);
  await confirmApply(databasePath(output), result.report.id, source, preview.token!); assert.match(await readFile(join(source, 'index.html'), 'utf8'), /const game/);
}));
