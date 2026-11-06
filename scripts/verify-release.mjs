import { mkdtemp, readFile, rm, stat, writeFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const exec = promisify(execFile); const name = `ctx-linux-${process.arch}`;
const archive = resolve('releases', name + '.tar.gz');
const expected = (await readFile(archive + '.sha256', 'utf8')).trim().split(/\s+/)[0];
assert.equal(createHash('sha256').update(await readFile(archive)).digest('hex'), expected);
const root = await mkdtemp(join(tmpdir(), 'ctx-release-check-'));
try {
  await exec('tar', ['-xzf', archive, '-C', root]); const app = join(root, name);
  const version = await exec(join(app, 'ctx'), ['--version'], { cwd: root, env: { ...process.env, NODE_PATH: '' } }); assert.equal(version.stdout.trim(), 'ctx 0.1.0');
  const runtime = join(app, 'runtime', 'bin', 'node'); const runtimeCheck = await exec(runtime, ['-p', 'process.execPath']); assert.equal(runtimeCheck.stdout.trim(), runtime);
  const security = await exec(runtime, [join(app, 'app', 'dist', 'packages', 'security', 'src', 'worker.js'), '--check'], { cwd: root, env: { ...process.env, NODE_PATH: '' } }); assert.match(security.stdout, /Security engine ready/);
  let doctor;
  try { doctor = await exec(join(app, 'ctx'), ['doctor'], { cwd: root, env: { ...process.env, NODE_PATH: '' } }); }
  catch (error) { doctor = error; assert.equal(error.code, 1, error.stderr); }
  assert.match(doctor.stdout, /Execution engine: ready/); assert.match(doctor.stdout, /Security engine: ready/);
  await new Promise((resolveResult, reject) => {
    const child = spawn(join(app, 'ctx'), ['--repo', join(app, 'examples', 'hello')], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; let askedHelp = false; let askedQuit = false;
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Relocated terminal timed out: ${output}`)); }, 10_000);
    child.stdout.on('data', data => {
      output += data.toString();
      if (!askedHelp && output.includes('ctx >')) { askedHelp = true; child.stdin.write('/help\n'); }
      if (!askedQuit && output.includes('Commands:')) { askedQuit = true; child.stdin.write('/quit\n'); }
    });
    child.stderr.on('data', data => { output += data.toString(); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('exit', code => { clearTimeout(timer); try { assert.equal(code, 0, output); assert.match(output, /Session closed/); assert.doesNotMatch(output, /@openai|codex-sdk|codex-security/); resolveResult(); } catch (error) { reject(error); } });
  });
  for (const mode of ['quit', 'interrupt', 'terminate']) await exec('python3', [resolve('scripts/verify-terminal.py'), join(app, 'ctx'), join(app, 'examples', 'hello'), mode], { timeout: 60_000 });
  const prefix = join(root, 'install with spaces'); await exec(join(app, 'install.sh'), [prefix], { cwd: root });
  assert.equal((await exec(join(prefix, 'bin', 'ctx'), ['--version'], { cwd: root })).stdout.trim(), 'ctx 0.1.0');
  assert.ok((await stat(join(prefix, 'share', 'ctx', '0.1.0', 'runtime', 'bin', 'node'))).isFile());
  await writeFile(join(prefix, 'share/ctx/0.1.0/stale-install.txt'), 'old release');
  await assert.rejects(exec(join(app, 'install.sh'), [prefix]), /installation exists/);
  await exec(join(app, 'install.sh'), ['--upgrade', prefix]);
  const backups = (await readdir(join(prefix, 'share/ctx'))).filter(name => name.startsWith('0.1.0.backup-'));
  assert.equal(backups.length, 1);
  assert.equal(await readFile(join(prefix, 'share/ctx', backups[0], 'stale-install.txt'), 'utf8'), 'old release');
  await assert.rejects(readFile(join(prefix, 'share/ctx/0.1.0/stale-install.txt')));
  await exec('python3', [resolve('scripts/verify-terminal.py'), join(prefix, 'bin', 'ctx'), join(app, 'examples', 'hello'), 'quit'], { timeout: 60_000 });
  console.log('Release verified: checksum, relocation, private runtime, engine imports, plain and full-screen terminal interaction, restored terminal modes, installation, explicit upgrade with backup, and the installed executable.');
} finally { await rm(root, { recursive: true, force: true }); }
