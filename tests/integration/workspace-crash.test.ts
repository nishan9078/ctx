import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { writeFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { OwnedWorkspaces } from '../../packages/core/src/owned-workspaces.js';
import { liveProcessGroup } from '../../packages/environment/src/process-group.js';
import { codexFixture } from '../fixtures/codex.js';
import { fakeCodex } from '../fixtures/fake-codex.js';
import { repositoryActor as actor } from '../fixtures/repository.js';
test('SIGKILL during a workspace edit retains recoverable output, stops orphan workers and safely archives before cleanup', { timeout: 20000 }, async () => {
  const f = await codexFixture(); await writeFile(join(f.project, 'human.txt'), 'untouched human edit'); const executable = await fakeCodex(f.root);
  const child = fork(resolve('dist/tests/fixtures/owned-queue-owner.js'), [f.filename, executable], { execArgv: [], env: { ...process.env, NODE_TEST_CONTEXT: undefined }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const exited = once(child, 'exit'); let pgid = 0; let timeout: NodeJS.Timeout | undefined;
  try {
    const message = await Promise.race([once(child, 'message').then(([message]) => message as { type: string; workspaceId: string; pgid: number }), exited.then(() => { throw new Error('Owner exited before edit boundary'); }), new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('Edit boundary timed out')), 10000); })]);
    clearTimeout(timeout); assert.equal(message.type, 'running'); pgid = message.pgid;
    const workspace = f.repository.workspaces.get(message.workspaceId); assert.equal(workspace.state, 'ready');
    assert.equal(await readFile(join(workspace.identity.worktree, 'recovery.txt'), 'utf8'), 'recoverable fixture edit\n');
    child.kill('SIGKILL'); await exited;
    const until = Date.now() + 5000; while (liveProcessGroup(pgid).length && Date.now() < until) await delay(25);
    assert.deepEqual(liveProcessGroup(pgid), []);
    const db = new DatabaseSync(f.filename); try { db.exec("UPDATE ctx_leases SET expires_at='2000-01-01T00:00:00.000Z'"); } finally { db.close(); }
    const manager = new OwnedWorkspaces(f.repository); await manager.reconcileOrphans(actor);
    assert.equal(f.repository.getTask('task').state, 'blocked'); assert.notEqual(f.repository.queue.attempts('task')[0].state, 'completed');
    assert.ok(f.repository.artifacts('task').some(artifact => artifact.kind === 'codex-raw-log'));
    f.repository.workspaces.assertQuiescent(workspace.id); await assert.rejects(manager.cleanup(workspace.id, actor, { retentionMs: 0 }), /archive/);
    const archived = await manager.archive(workspace.id, actor); assert.ok(archived.archiveArtifactId);
    assert.equal((await manager.reconcileOrphans(actor, { cleanup: true, retentionMs: 0 })).find(entry => entry.id === workspace.id)?.status, 'retained-refused');
    const task = f.repository.getTask('task'); f.repository.queue.controlTask('task', 'cancel', task.revision, actor, 'Owner completed recovery review and cancelled task');
    assert.equal((await manager.reconcileOrphans(actor, { cleanup: true, retentionMs: 0 })).find(entry => entry.id === workspace.id)?.status, 'removed');
    const diff = f.repository.artifacts('task').find(artifact => artifact.kind === 'workspace-diff')!;
    assert.match(await readFile(join(f.repository.dataDirectory, diff.location), 'utf8'), /recoverable fixture edit/);
    assert.equal(await readFile(join(f.project, 'human.txt'), 'utf8'), 'untouched human edit');
    assert.equal((await f.repository.verifyStoredArtifact(archived.archiveArtifactId!)).id, archived.archiveArtifactId);
  } finally {
    clearTimeout(timeout); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    if (pgid && liveProcessGroup(pgid).length) process.kill(-pgid, 'SIGKILL');
    await f.cleanup();
  }
});
