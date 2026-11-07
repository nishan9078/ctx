import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, mkdir, symlink, rename, lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { OwnedWorkspaces } from '../../packages/core/src/owned-workspaces.js';
import { runProcess } from '../../packages/environment/src/process-manager.js';
import { codexFixture } from '../fixtures/codex.js';
import { repositoryActor as actor } from '../fixtures/repository.js';
async function fixture() {
  const f = await codexFixture(); const manager = new OwnedWorkspaces(f.repository);
  const claim = f.repository.queue.claim({ ownerId: 'test', workerKind: 'codex', leaseMs: 10000 }, actor)!; f.repository.queue.start(claim, actor);
  return { ...f, manager, claim, stop() { f.repository.queue.settle(claim, { kind: 'blocked', reason: 'Worker fixture quiesced' }, actor); }, cancel() { const task = f.repository.getTask('task'); f.repository.queue.controlTask('task', 'cancel', task.revision, actor, 'Owner cancelled retained workspace'); } };
}
test('owned task branch preserves source edits, archives ignored/new/committed files and cleans idempotently', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.project, 'human.txt'), 'dirty source'); await writeFile(join(f.project, '.gitignore'), 'ignored\n'); await writeFile(join(f.project, 'ignored'), 'ignored source');
    const workspace = await f.manager.create(f.claim, actor);
    assert.match(workspace.identity.baseSha!, /^[a-f0-9]{40,64}$/); assert.equal(workspace.identity.branch, `ctx/task/${f.claim.attempt.id}`);
    await writeFile(join(workspace.identity.worktree, 'human.txt'), 'task edit'); await writeFile(join(workspace.identity.worktree, 'new.txt'), 'new file');
    assert.equal((await runProcess('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', '-c', 'core.hooksPath=/dev/null', 'commit', '-am', 'fixture committed edit'], workspace.identity.worktree)).code, 0);
    const archived = await f.manager.archive(workspace.id, actor, f.claim); assert.equal(archived.state, 'archived');
    const patch = f.repository.artifacts('task').find(a => a.kind === 'workspace-diff')!; assert.match(await readFile(join(f.repository.dataDirectory, patch.location), 'utf8'), /task edit/);
    const receipt = JSON.parse(await readFile(join(f.repository.dataDirectory, f.repository.artifacts('task').find(a => a.id === archived.archiveArtifactId)!.location), 'utf8'));
    const treeArtifact = f.repository.artifacts('task').find(a => a.id === receipt.treeArtifactId)!;
    const tree = JSON.parse(await readFile(join(f.repository.dataDirectory, treeArtifact.location), 'utf8')); assert.ok(tree.entries.some((item: { path: string }) => item.path === 'ignored'));
    await assert.rejects(f.manager.cleanup(workspace.id, actor, { retentionMs: 0 }), /active/);
    f.stop(); f.cancel(); await assert.rejects(f.manager.cleanup(workspace.id, actor), /retention/);
    await f.manager.cleanup(workspace.id, actor, { retentionMs: 0 }); await f.manager.cleanup(workspace.id, actor, { retentionMs: 0 });
    const bundle = f.repository.artifacts('task').find(a => a.id === receipt.gitArtifactId)!;
    const restored = join(f.root, 'restored-from-bundle');
    assert.equal((await runProcess('git', ['clone', '-q', join(f.repository.dataDirectory, bundle.location), restored], f.root)).code, 0);
    assert.equal((await runProcess('git', ['checkout', '-q', workspace.identity.branch!], restored)).code, 0);
    assert.equal(await readFile(join(restored, 'human.txt'), 'utf8'), 'task edit');
    assert.equal(Buffer.from(tree.entries.find((entry: { path: string }) => entry.path === 'new.txt').content, 'base64').toString(), 'new file');
    await assert.rejects(lstat(workspace.identity.root), { code: 'ENOENT' }); assert.equal(await readFile(join(f.project, 'human.txt'), 'utf8'), 'dirty source');
    assert.equal(f.repository.workspaces.get(workspace.id).state, 'removed');
    await mkdir(workspace.identity.root); await writeFile(join(workspace.identity.root, 'human'), 'preserve');
    await assert.rejects(f.manager.cleanup(workspace.id, actor, { retentionMs: 0 }), /recreated/); assert.equal(await readFile(join(workspace.identity.root, 'human'), 'utf8'), 'preserve');
  } finally { await f.cleanup(); }
});
test('cleanup refuses unarchived dirty work and human-owned or substituted directories', async () => {
  const f = await fixture();
  try {
    const workspace = await f.manager.create(f.claim, actor); await f.manager.archive(workspace.id, actor, f.claim);
    f.stop(); f.cancel(); await writeFile(join(workspace.identity.worktree, 'after-archive'), 'human edit');
    await assert.rejects(f.manager.cleanup(workspace.id, actor, { retentionMs: 0 }), /Unarchived/);
    assert.equal(f.repository.workspaces.get(workspace.id).state, 'archived');
    await f.manager.archive(workspace.id, actor); // Explicitly archive the newly observed content before cleanup.
    await writeFile(join(workspace.identity.snapshot, 'human-baseline-note'), 'preserve snapshot edit');
    await assert.rejects(f.manager.cleanup(workspace.id, actor, { retentionMs: 0 }), /snapshot changes/);
    assert.equal(await readFile(join(workspace.identity.snapshot, 'human-baseline-note'), 'utf8'), 'preserve snapshot edit');
    await f.manager.archive(workspace.id, actor);
    await runProcess('git', ['branch', 'human-reference'], workspace.identity.snapshot);
    await assert.rejects(f.manager.cleanup(workspace.id, actor, { retentionMs: 0 }), /Git references/);
    await f.manager.archive(workspace.id, actor);
    await writeFile(join(workspace.identity.root, 'human-created'), 'preserve');
    await assert.rejects(f.manager.cleanup(workspace.id, actor, { retentionMs: 0 }), /unowned/);
    await assert.rejects(f.manager.cleanup('not-owned', actor, { retentionMs: 0 }), /missing/);
    await rename(workspace.identity.snapshot, join(workspace.identity.root, 'preserved-snapshot')); await mkdir(workspace.identity.snapshot); await writeFile(join(workspace.identity.snapshot, 'human'), 'never delete');
    await assert.rejects(f.manager.cleanup(workspace.id, actor, { retentionMs: 0 }), /identity/); assert.equal(await readFile(join(workspace.identity.snapshot, 'human'), 'utf8'), 'never delete');
  } finally { await f.cleanup(); }
});
test('cancelled creation and Git lock conflicts retain owned partial state without touching source', async () => {
  for (const mode of ['cancel', 'lock', 'symlink', 'source-lock'] as const) {
    const f = await fixture(); const abort = new AbortController();
    try {
      await writeFile(join(f.project, 'human'), 'preserve');
      if (mode === 'source-lock') { await runProcess('git', ['init', '-q'], f.project); await writeFile(join(f.project, '.git', 'index.lock'), 'human lock'); }
      if (mode === 'symlink') await symlink(join(f.root, 'outside'), join(f.project, 'unsafe'));
      await assert.rejects(f.manager.create(f.claim, actor, { signal: abort.signal, async onStage(stage) {
        if (stage === 'git-initialized' && mode === 'lock') await writeFile(join(f.repository.dataDirectory, 'codex-work', f.claim.attempt.id, 'snapshot', '.git', 'index.lock'), 'human lock');
        if (stage === 'before-worktree' && mode === 'cancel') abort.abort();
      } }));
      assert.equal(await readFile(join(f.project, 'human'), 'utf8'), 'preserve'); assert.equal(f.repository.workspaces.get(f.claim.attempt.id).state, 'creating');
      f.stop(); f.cancel(); await assert.rejects(f.manager.cleanup(f.claim.attempt.id, actor, { retentionMs: 0 }), /archive/);
      const scan = await f.manager.scan(); assert.ok(scan.some(item => item.id === f.claim.attempt.id));
    } finally { await f.cleanup(); }
  }
});
test('cleanup can resume after interruption between worktree and private snapshot removal', async () => {
  const f = await fixture();
  try {
    const workspace = await f.manager.create(f.claim, actor); await f.manager.archive(workspace.id, actor, f.claim); f.stop(); f.cancel();
    await assert.rejects(f.manager.cleanup(workspace.id, actor, { retentionMs: 0, onStage() { throw new Error('Injected cleanup crash'); } }), /Injected/);
    assert.equal(f.repository.workspaces.get(workspace.id).state, 'cleanup'); await f.manager.cleanup(workspace.id, actor, { retentionMs: 0 });
    assert.equal(f.repository.workspaces.get(workspace.id).state, 'removed');
    await mkdir(join(f.repository.dataDirectory, 'codex-work', 'human')); assert.ok((await f.manager.scan()).some(item => item.id === 'human' && item.status === 'unowned-refused'));
  } finally { await f.cleanup(); }
});

test('unsafe Git filters and Git-dir environment overrides cannot run during evidence capture', async () => {
  const f = await fixture();
  try {
    const workspace = await f.manager.create(f.claim, actor);
    const marker = join(f.root, 'must-not-exist');
    await runProcess('git', ['config', 'filter.bad.clean', `touch ${marker}`], workspace.identity.worktree);
    await writeFile(join(workspace.identity.worktree, '.gitattributes'), '* filter=bad\n');
    await assert.rejects(f.manager.archive(workspace.id, actor, f.claim), /unsafe overrides/);
    await assert.rejects(lstat(marker), { code: 'ENOENT' });
    const { privateGit } = await import('../../packages/environment/src/private-git.js');
    const previous = process.env.GIT_WORK_TREE; const previousDir = process.env.GIT_DIR;
    try { process.env.GIT_WORK_TREE = f.project; process.env.GIT_DIR = join(f.project, '.git');
      const actual = await privateGit(['rev-parse', '--show-toplevel'], workspace.identity.worktree); assert.equal(actual.output.trim(), workspace.identity.worktree);
    } finally { if (previous === undefined) delete process.env.GIT_WORK_TREE; else process.env.GIT_WORK_TREE = previous; if (previousDir === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = previousDir; }
  } finally { await f.cleanup(); }
});

test('valid dotted task identifiers produce safe task branch names', async () => {
  const f = await codexFixture(); const { submissionFixture } = await import('../fixtures/repository.js');
  try {
    const input = submissionFixture('task..lock'); input.spec.priority = 'urgent'; f.repository.submitTask(input, actor); f.repository.queue.refresh(actor);
    const claim = f.repository.queue.claim({ ownerId: 'dotted', workerKind: 'codex', leaseMs: 10000 }, actor)!; assert.equal(claim.task.spec.id, 'task..lock'); f.repository.queue.start(claim, actor);
    const workspace = await new OwnedWorkspaces(f.repository).create(claim, actor); assert.equal(workspace.identity.branch, `ctx/task__lock/${claim.attempt.id}`);
    f.repository.queue.settle(claim, { kind: 'blocked', reason: 'Fixture quiesced' }, actor);
  } finally { await f.cleanup(); }
});
