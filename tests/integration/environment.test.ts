import { once } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runTask, databasePath } from '../../packages/core/src/orchestrator.js';
import { LocalDockerDriver } from '../../packages/environment/src/docker.js';
import { DockerAccessError, classifyDockerAccess } from '../../packages/environment/src/docker-diagnostics.js';
import { TaskStore } from '../../packages/persistence/src/database.js';
import { FakeDocker } from '../fixtures/fake-docker.js';
import { prepareWorkspace } from '../../packages/environment/src/workspace.js';
import { worktreeMetadata } from '../../packages/environment/src/git-worktree.js';
import { runProcess } from '../../packages/environment/src/process-manager.js';
import { inspectOwned } from '../../packages/environment/src/docker.js';
const fixture = resolve('tests/fixtures/feature');
async function temporary() { return mkdtemp(join(tmpdir(), 'harness-env-test-')); }
async function clean(root: string, workspace?: string) { await rm(root, { force: true, recursive: true }); if (workspace) await rm(resolve(workspace, '..'), { force: true, recursive: true }); }
test('private Git worktree preserves source dirty/untracked and ignored development files', async () => {
  const root = await temporary();
  try {
    const source = join(root, 'source'); await mkdir(source); await writeFile(join(source, '.gitignore'), '.env\n');
    await writeFile(join(source, 'index.js'), 'initial'); await runProcess('git', ['init', '-q'], source);
    await runProcess('git', ['add', '.'], source); await runProcess('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'initial'], source);
    await writeFile(join(source, 'index.js'), 'dirty'); await writeFile(join(source, 'untracked'), 'preserve'); await writeFile(join(source, '.env'), 'LOCAL=development');
    const before = await runProcess('git', ['status', '--porcelain'], source);
    const workspace = await prepareWorkspace(source, join(root, 'workspace'));
    assert.match(await readFile(join(workspace, '.git'), 'utf8'), /^gitdir:/);
    assert.equal(await readFile(join(workspace, 'index.js'), 'utf8'), 'dirty'); assert.equal(await readFile(join(workspace, 'untracked'), 'utf8'), 'preserve'); assert.equal(await readFile(join(workspace, '.env'), 'utf8'), 'LOCAL=development');
    assert.equal(await worktreeMetadata(workspace), join(root, 'snapshot', '.git'));
    await writeFile(join(workspace, 'index.js'), 'changed in task');
    assert.equal(await readFile(join(source, 'index.js'), 'utf8'), 'dirty');
    assert.equal((await runProcess('git', ['status', '--porcelain'], source)).output, before.output);
  } finally { await clean(root); }
});
test('deterministic PostgreSQL recovery precedes model repair, preserves evidence and cleans only task resources (simulated Docker)', async () => {
  const root = await temporary(); const docker = new FakeDocker(); let workspace: string | undefined; let calls = 0;
  try {
    const { report, directory } = await runTask({ request: 'feature', repositoryPath: fixture, outputDirectory: root, environment: { services: { postgres: true } } }, { async execute(input) {
      calls++; await writeFile(join(input.workspacePath, 'feature.js'), 'export const feature = true;'); return { outcome: 'completed', summary: 'done' };
    } }, { docker });
    workspace = report.workspacePath; assert.equal(report.outcome, 'completed'); assert.equal(calls, 1); assert.equal(report.usage.retries, 0);
    assert.match(await readFile(join(directory, 'test.log'), 'utf8'), /ECONNREFUSED/); assert.match(report.verification[1].artifact, /verification-1/);
    assert.equal(report.environment.recoveries?.[0].status, 'passed'); assert.ok(report.limitations.some(item => /simulated/.test(item)));
    assert.equal(docker.resources.size, 0); assert.ok(docker.calls.some(args => args.includes('--internal')));
    const pg = docker.calls.find(args => args.includes('harness.purpose=postgres') && args[0] === 'run')!;
    assert.ok(pg.includes('postgres:16-bookworm')); assert.ok(!pg.includes('-p')); assert.ok(pg.includes('PGDATA=/var/lib/postgresql/data/pgdata'));
    const store = new TaskStore(databasePath(root));
    try {
      const task = store.get(report.id); assert.equal(task.environment!.remainingRecoveryAttempts, 2);
      assert.equal(task.environment!.dependencies[0].kind, 'real'); assert.ok(task.environment!.resources.every(item => item.status === 'removed'));
      assert.ok(store.events(report.id).some(item => item.type === 'environment.recovery.intent'));
      assert.ok((store.db.prepare("SELECT status FROM resources WHERE task_id=? AND kind='container'").all(report.id) as { status: string }[]).every(item => item.status === 'removed'));
    } finally { store.close(); }
  } finally { await clean(root, workspace); }
});
for (const mode of ['unavailable', 'budget', 'repeated', 'missing-key', 'install-denied'] as const) test(`environment blocks safely: ${mode}`, async () => {
  const root = await temporary(); const docker = new FakeDocker(); let workspace: string | undefined; let calls = 0;
  docker.available = mode !== 'unavailable';
  if (mode === 'repeated') docker.failures.push('DATABASE_URL PostgreSQL ECONNREFUSED postgres:5432');
  if (mode === 'missing-key') docker.failures = ['PAYMENTS_API_KEY required'];
  if (mode === 'install-denied') docker.failures = ["Cannot find package 'pg'"];
  try {
    const result = await runTask({ request: 'feature', repositoryPath: fixture, outputDirectory: root, maxRepairAttempts: 2,
      environment: { services: { postgres: true }, maxRecoveryAttempts: mode === 'budget' ? 0 : 3 },
    }, { async execute() { calls++; return { outcome: 'completed', summary: 'done' }; } }, { docker });
    workspace = result.report.workspacePath; assert.equal(result.report.outcome, 'blocked'); assert.equal(calls, mode === 'unavailable' ? 0 : 1); assert.equal(result.report.usage.retries, 0);
    assert.equal(docker.resources.size, 0);
  } finally { await clean(root, workspace); }
});
test('explicit mock contract is marked mock and live integration unverified (simulated Docker)', async () => {
  const root = await temporary(); const docker = new FakeDocker(); docker.failures = ['PAYMENTS_API_KEY required']; let workspace: string | undefined;
  try {
    const { report } = await runTask({ request: 'feature', repositoryPath: fixture, outputDirectory: root,
      environment: { services: { mock: { urlVariable: 'PAYMENTS_API_URL', keyVariable: 'PAYMENTS_API_KEY', routes: [{ method: 'GET', path: '/account', status: 200, body: { balance: 1 } }] } } },
    }, { async execute() { return { outcome: 'completed', summary: 'done' }; } }, { docker });
    workspace = report.workspacePath; assert.equal(report.outcome, 'completed'); assert.match(report.environment.dependencies, /mock: mock/);
    assert.ok(report.limitations.some(item => /live external API integration remains unverified/.test(item)));
    assert.ok(docker.calls.some(args => args.includes('PAYMENTS_API_KEY=harness-mock-only')));
    assert.equal(docker.resources.size, 0);
  } finally { await clean(root, workspace); }
});
test('missing env creates non-secret development placeholders without copying example values', async () => {
  const root = await temporary(); const source = join(root, 'source'); await mkdir(source); await writeFile(join(source, 'package.json'), '{"scripts":{"build":"true","test":"true"}}');
  await writeFile(join(source, '.env.example'), 'APP_MODE=private-value-not-to-copy\nNODE_OPTIONS=--require=/unsafe\n');
  const docker = new FakeDocker(); docker.failures = ["ENOENT: open '.env'"]; let workspace: string | undefined;
  try {
    const result = await runTask({ request: 'feature', repositoryPath: source, outputDirectory: join(root, 'output') }, { async execute() { return { outcome: 'completed', summary: 'done' }; } }, { docker });
    workspace = result.report.workspacePath; assert.equal(result.report.outcome, 'completed');
    assert.equal(await readFile(join(workspace!, '.env'), 'utf8'), 'APP_MODE=HARNESS_DEVELOPMENT_PLACEHOLDER\n');
    await assert.rejects(readFile(join(source, '.env')), /ENOENT/);
    await assert.rejects(prepareWorkspace(source, join(source, '..still-inside')), /outside source/);
  } finally { await clean(root, workspace); }
});
test('frozen dependency installation requires explicit permission and remains sandboxed', async () => {
  const root = await temporary(); const source = join(root, 'source'); await mkdir(source); await writeFile(join(source, 'package.json'), '{"scripts":{"build":"true","test":"true"}}'); await writeFile(join(source, 'package-lock.json'), '{}');
  const docker = new FakeDocker(); docker.failures = ["Cannot find package 'pg'"]; let workspace: string | undefined;
  try {
    const result = await runTask({ request: 'feature', repositoryPath: source, outputDirectory: join(root, 'output'), environment: { allowDependencyInstall: true } }, { async execute() { return { outcome: 'completed', summary: 'done' }; } }, { docker });
    workspace = result.report.workspacePath; assert.equal(result.report.outcome, 'completed');
    const install = docker.calls.find(args => args.includes('harness.purpose=install') && args[0] === 'run')!;
    assert.match(install.at(-1)!, /npm ci --ignore-scripts/); assert.equal(install[install.indexOf('--network') + 1], 'bridge'); assert.ok(install.includes('--cap-drop=ALL'));
    assert.ok(docker.calls.filter(args => args.includes('harness.purpose=check') && args[0] === 'run').every(args => args[args.indexOf('--network') + 1] !== 'bridge'));
  } finally { await clean(root, workspace); }
});
test('ownership validation prevents removal/adoption of unrelated Docker containers', async () => {
  const docker = new FakeDocker(); docker.resources.set('foreign', { kind: 'container', purpose: 'postgres', task: 'another-task', running: true });
  await assert.rejects(inspectOwned(docker, 'current-task', { name: 'foreign', kind: 'container', status: 'intent', purpose: 'postgres' }), /foreign Docker resource/);
  assert.equal(docker.resources.size, 1); assert.ok(!docker.calls.some(args => args[1] === 'rm'));
});
test('unhealthy disposable database blocks recovery and never claims health success (simulated Docker)', { timeout: 15_000 }, async () => {
  const root = await temporary(); const docker = new FakeDocker(); docker.healthFails = true; let workspace: string | undefined;
  try {
    const result = await runTask({ request: 'feature', repositoryPath: fixture, outputDirectory: root, environment: { services: { postgres: true } } }, { async execute() { return { outcome: 'completed', summary: 'done' }; } }, { docker });
    workspace = result.report.workspacePath; assert.equal(result.report.outcome, 'blocked');
    assert.equal(result.report.environment.recoveries?.[0].status, 'failed'); assert.doesNotMatch(result.report.environment.dependencies, /health verified=true/);
    assert.equal(docker.resources.size, 0);
  } finally { await clean(root, workspace); }
});
test('mock template serves explicit contracts and health checks without a real external API', { timeout: 10_000 }, async () => {
  const { fork } = await import('node:child_process');
  const root = await temporary(); await writeFile(join(root, 'routes.json'), JSON.stringify([{ method: 'POST', path: '/pay', status: 201, body: { accepted: true } }]));
  const child = fork(resolve('templates/mock-services/server.mjs'), [], { execArgv: [], env: { PATH: process.env.PATH, PORT: '0', HARNESS_MOCK_ROUTES: join(root, 'routes.json') }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const exited = once(child, 'exit');
  try {
    const [message] = await Promise.race([once(child, 'message'), exited.then(() => { throw new Error('Mock server exited early'); })]);
    const base = `http://127.0.0.1:${(message as { port: number }).port}`;
    const health = await fetch(`${base}/__harness_health`); assert.deepEqual(await health.json(), { status: 'ready', mock: true });
    const response = await fetch(`${base}/pay`, { method: 'POST' }); assert.equal(response.status, 201); assert.equal(response.headers.get('x-harness-mock'), 'true'); assert.deepEqual(await response.json(), { accepted: true });
    assert.equal((await fetch(`${base}/not-configured`)).status, 404);
  } finally { child.kill('SIGTERM'); await exited; await clean(root); }
});
test('schema migration preserves legacy resource data and exposes cleanup status', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const root = await temporary(); const path = join(root, 'legacy.sqlite');
  try {
    const legacy = new DatabaseSync(path);
    legacy.exec("CREATE TABLE resources(task_id TEXT NOT NULL,path TEXT NOT NULL,kind TEXT NOT NULL,PRIMARY KEY(task_id,path)); INSERT INTO resources VALUES('legacy-task','/retained/workspace','workspace'); PRAGMA user_version=1;"); legacy.close();
    const store = new TaskStore(path);
    try {
      assert.equal((store.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 2);
      const row = store.db.prepare('SELECT path,status,data FROM resources').get() as { path: string; status: string; data: string };
      assert.equal(row.path, '/retained/workspace'); assert.equal(row.status, 'ready'); assert.equal(row.data, '{}');
    } finally { store.close(); }
  } finally { await clean(root); }
});
test('environment budgets cannot be reset or changed without a persisted recovery intent', async () => {
  const root = await temporary(); let workspace: string | undefined;
  try {
    const result = await runTask({ request: 'feature', repositoryPath: fixture, outputDirectory: root, environment: { mode: 'host' } }, { async execute() { return { outcome: 'completed', summary: 'done' }; } });
    workspace = result.report.workspacePath; const store = new TaskStore(databasePath(root)); const owner = store.claim(result.report.id, 1000);
    try {
      const before = store.events(result.report.id).length;
      assert.throws(() => store.update(result.report.id, owner, 'invalid', {}, task => { task.environment!.remainingRecoveryAttempts++; }), /recovery budget/);
      assert.throws(() => store.update(result.report.id, owner, 'invalid', {}, task => { task.environment!.config.allowImagePull = true; }), /immutable/);
      assert.equal(store.events(result.report.id).length, before);
    } finally { store.release(result.report.id, owner); store.close(); }
  } finally { await clean(root, workspace); }
});
for (const allowImagePull of [false, true]) test(`missing images respect explicit pull permission: ${allowImagePull}`, async () => {
  const root = await temporary(); const docker = new FakeDocker(); docker.imagesAvailable = false; docker.failures = [];
  let workspace: string | undefined; let calls = 0;
  try {
    const result = await runTask({ request: 'feature', repositoryPath: fixture, outputDirectory: root, environment: { allowImagePull } }, { async execute() { calls++; return { outcome: 'completed', summary: 'done' }; } }, { docker });
    workspace = result.report.workspacePath;
    assert.equal(result.report.outcome, allowImagePull ? 'completed' : 'blocked');
    assert.equal(calls, allowImagePull ? 1 : 0);
    const pullIndex = docker.calls.findIndex(args => args[0] === 'pull');
    const networkIndex = docker.calls.findIndex(args => args[0] === 'network' && args[1] === 'create');
    if (allowImagePull) { assert.ok(pullIndex >= 0 && pullIndex < networkIndex); assert.ok(docker.calls.slice(pullIndex + 1, networkIndex).some(args => args[0] === 'image' && args[1] === 'inspect')); }
    else assert.equal(pullIndex, -1);
    assert.equal(docker.resources.size, 0);
  } finally { await clean(root, workspace); }
});
test('image inspection infrastructure failures never trigger a pull or coding attempt', async () => {
  const root = await temporary(); let workspace: string | undefined;
  class FailedInspection extends FakeDocker {
    override async command(args: string[]) {
      if (args[0] === 'image') { this.calls.push(args); return { code: 1, output: 'Docker daemon connection failed', timedOut: false, truncated: false }; }
      return super.command(args);
    }
  }
  const docker = new FailedInspection();
  try {
    const result = await runTask({ request: 'feature', repositoryPath: fixture, outputDirectory: root, environment: { allowImagePull: true } }, { async execute() { throw new Error('Must not spend a coding turn'); } }, { docker });
    workspace = result.report.workspacePath; assert.equal(result.report.outcome, 'blocked');
    assert.match(result.report.implemented.summary, /Cannot inspect Docker image/);
    assert.ok(!docker.calls.some(args => args[0] === 'pull' || args[0] === 'run'));
  } finally { await clean(root, workspace); }
});
test('socket failures retain process diagnostics and do not retry with elevated permissions', async () => {
  const root = await temporary(); let workspace: string | undefined; let calls = 0;
  const docker = new LocalDockerDriver(async command => {
    assert.equal(command, 'docker'); calls++;
    return { code: 1, output: 'permission denied while trying to connect to the docker API at unix:///var/run/docker.sock', timedOut: false, truncated: false };
  });
  try {
    const result = await runTask({ request: 'feature', repositoryPath: fixture, outputDirectory: root }, { async execute() { throw new Error('Must not spend a coding turn'); } }, { docker });
    workspace = result.report.workspacePath; assert.equal(result.report.outcome, 'blocked'); assert.equal(calls, 1);
    const diagnostic = JSON.parse(await readFile(result.report.environment.diagnostic!.artifact!, 'utf8'));
    assert.equal(diagnostic.facts.uid, process.getuid?.());
    assert.deepEqual(diagnostic.facts.groups, process.getgroups?.());
    assert.equal(result.report.nextActions[0], diagnostic.recommendation);
    const store = new TaskStore(databasePath(root));
    try { assert.ok(store.events(result.report.id).some(event => event.type === 'environment.docker.blocked')); } finally { store.close(); }
  } finally { await clean(root, workspace); }
});
for (const failure of ['permission', 'container-start'] as const) test(`control-plane failure during verification blocks without model repair: ${failure}`, async () => {
  const root = await temporary(); let workspace: string | undefined; let turns = 0;
  class FailedRun extends FakeDocker {
    override async command(args: string[]) {
      if (args[0] === 'run') {
        this.calls.push(args);
        if (failure === 'permission') throw new DockerAccessError('Docker socket denied', classifyDockerAccess({ uid: 1000, gid: 1000, groups: [1000] }, 'run'));
        return { code: 125, output: 'Docker failed to mount the workspace', timedOut: false, truncated: false };
      }
      return super.command(args);
    }
  }
  const docker = new FailedRun();
  try {
    const result = await runTask({ request: 'feature', repositoryPath: fixture, outputDirectory: root, maxRepairAttempts: 2 }, { async execute() { turns++; return { outcome: 'completed', summary: 'done' }; } }, { docker });
    workspace = result.report.workspacePath; assert.equal(result.report.outcome, 'blocked'); assert.equal(turns, 1); assert.equal(result.report.usage.retries, 0);
    assert.equal(result.report.verification.length, 1); assert.equal(result.report.verification[0].status, 'unavailable');
    assert.match(await readFile(result.report.verification[0].artifact, 'utf8'), failure === 'permission' ? /socket denied/ : /failed to mount/);
    assert.equal(docker.resources.size, 0);
    if (failure === 'permission') assert.ok(result.report.environment.diagnostic);
  } finally { await clean(root, workspace); }
});
test('permission failure provisioning PostgreSQL retains recovery evidence and the original access diagnostic', async () => {
  const root = await temporary(); let workspace: string | undefined;
  class PostgresAccessFailure extends FakeDocker {
    override async command(args: string[]) {
      if (args[0] === 'run' && args.includes('harness.purpose=postgres')) {
        this.calls.push(args);
        throw new DockerAccessError('Docker access denied provisioning PostgreSQL', classifyDockerAccess({ uid: 1000, gid: 1000, groups: [1000] }, 'run'));
      }
      return super.command(args);
    }
  }
  const docker = new PostgresAccessFailure();
  try {
    const result = await runTask({ request: 'feature', repositoryPath: fixture, outputDirectory: root, maxRepairAttempts: 2, environment: { services: { postgres: true } } }, { async execute() { return { outcome: 'completed', summary: 'done' }; } }, { docker });
    workspace = result.report.workspacePath;
    assert.equal(result.report.outcome, 'blocked'); assert.equal(result.report.usage.retries, 0);
    assert.equal(result.report.environment.recoveries?.[0].status, 'failed'); assert.ok(result.report.environment.diagnostic);
    assert.match(await readFile(result.report.environment.recoveries![0].artifact, 'utf8'), /Docker access denied provisioning PostgreSQL/);
    assert.equal(docker.resources.size, 0);
  } finally { await clean(root, workspace); }
});
