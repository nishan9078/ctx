import { access, cp, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile, chmod, lstat, readlink } from 'node:fs/promises';
import { dirname, join, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch)) throw new Error('Build this release on its target Linux x64/arm64 platform.');
const nodeVersion = '26.4.0'; const target = `linux-${process.arch}`;
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(pkg.version)) throw new Error('Invalid release version');
const cache = join(root, '.harness', 'release-cache'); await mkdir(cache, { recursive: true });
const filename = `node-v${nodeVersion}-${target}.tar.xz`; const archive = join(cache, filename);
async function download(name) {
  const output = join(cache, name); const temporary = output + '.partial';
  await exec('curl', ['--fail', '--location', '--silent', '--show-error', '--retry', '2', '--connect-timeout', '15', '--output', temporary, `https://nodejs.org/dist/v${nodeVersion}/${name}`], { maxBuffer: 1_000_000 });
  await rename(temporary, output); return output;
}
try { await access(archive); } catch { console.log('Downloading the official Node runtime…'); await download(filename); }
const sums = await readFile(await download('SHASUMS256.txt'), 'utf8');
const expected = sums.split('\n').find(line => line.trim().split(/\s+/)[1] === filename)?.split(/\s+/)[0];
const actual = createHash('sha256').update(await readFile(archive)).digest('hex');
if (!expected || actual !== expected) throw new Error('Official Node archive checksum mismatch; no release was created.');
const build = await mkdtemp(join(root, '.harness', 'release-build-'));
const name = `ctx-${target}`; const stage = join(build, name); const app = join(stage, 'app');
await mkdir(join(stage, 'runtime', 'bin'), { recursive: true }); await mkdir(app, { recursive: true });
await exec('tar', ['-xJf', archive, '-C', build, `node-v${nodeVersion}-${target}/bin/node`, `node-v${nodeVersion}-${target}/LICENSE`]);
await cp(join(build, `node-v${nodeVersion}-${target}`, 'bin', 'node'), join(stage, 'runtime', 'bin', 'node'));
await chmod(join(stage, 'runtime', 'bin', 'node'), 0o755);
await cp(join(build, `node-v${nodeVersion}-${target}`, 'LICENSE'), join(stage, 'runtime', 'LICENSE'));
for (const area of ['apps', 'packages']) await cp(join(root, 'dist', area), join(app, 'dist', area), { recursive: true });
await cp(join(root, 'templates'), join(app, 'templates'), { recursive: true });
await cp(join(root, 'tests', 'fixtures', 'feature'), join(stage, 'examples', 'hello'), { recursive: true, filter: source => !source.split(sep).includes('.harness') });
await writeFile(join(app, 'package.json'), JSON.stringify({ name: pkg.name, version: pkg.version, type: 'module' }, null, 2));
const moduleRoot = join(app, 'node_modules'); await mkdir(join(moduleRoot, '.bin'), { recursive: true });
const copied = new Map(); const packages = []; const binNames = new Set();
async function resolveDependency(source, name) {
  for (let current = source; ; current = dirname(current)) {
    const candidate = join(current, 'node_modules', name);
    try { await access(join(candidate, 'package.json')); return await realpath(candidate); } catch { /* Try the parent module search path. */ }
    if (dirname(current) === current) throw new Error(`Installed dependency missing: ${name} from ${source}`);
  }
}
async function linkPackage(source, location) {
  source = await realpath(source);
  let destination = copied.get(source);
  if (!destination) {
    const metadata = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
    const key = createHash('sha256').update(`${metadata.name}@${metadata.version}`).digest('hex').slice(0, 16);
    destination = join(moduleRoot, '.ctx-store', key, 'package'); copied.set(source, destination);
    await cp(source, destination, { recursive: true, verbatimSymlinks: true, filter: path => path !== join(source, 'node_modules') });
    packages.push({ name: metadata.name, version: metadata.version, license: metadata.license ?? 'see packaged license files' });
    const dependencies = { ...metadata.peerDependencies, ...metadata.dependencies, ...metadata.optionalDependencies };
    for (const dependency of Object.keys(dependencies ?? {})) {
      let resolved;
      try { resolved = await resolveDependency(source, dependency); }
      catch (error) { if (dependency in (metadata.optionalDependencies ?? {}) || metadata.peerDependenciesMeta?.[dependency]?.optional) continue; throw error; }
      await linkPackage(resolved, join(destination, 'node_modules', dependency));
    }
    const bins = typeof metadata.bin === 'string' ? { [metadata.name.split('/').at(-1)]: metadata.bin } : metadata.bin ?? {};
    for (const [bin, entry] of Object.entries(bins)) {
      if (binNames.has(bin)) continue;
      const binary = join(destination, entry); await chmod(binary, 0o755); binNames.add(bin);
      await symlink(relative(join(moduleRoot, '.bin'), binary), join(moduleRoot, '.bin', bin));
    }
  }
  await mkdir(dirname(location), { recursive: true });
  await symlink(relative(dirname(location), destination), location);
}
console.log('Packaging installed production dependencies…');
for (const dependency of Object.keys(pkg.dependencies)) await linkPackage(await resolveDependency(root, dependency), join(moduleRoot, dependency));
const launcher = `#!/bin/sh\nset -eu\nCTX_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexport CTX_EXECUTABLE_DIR="$CTX_ROOT"\nexport PATH="$CTX_ROOT/runtime/bin:$CTX_ROOT/app/node_modules/.bin:$PATH"\nexec "$CTX_ROOT/runtime/bin/node" --experimental-ffi --disable-warning=ExperimentalWarning "$CTX_ROOT/app/dist/apps/cli/src/index.js" "$@"\n`;
await writeFile(join(stage, 'ctx'), launcher, { mode: 0o755 });
await cp(join(root, 'scripts', 'install-release.sh'), join(stage, 'install.sh'));
await chmod(join(stage, 'install.sh'), 0o755);
await writeFile(join(stage, 'release-manifest.json'), JSON.stringify({ product: 'ctx', version: pkg.version, platform: target, node: nodeVersion, interface: 'opentui', displayModes: ['minimal', 'detailed'], packages }, null, 2) + '\n');
await writeFile(join(stage, 'README.txt'), `CTX ${pkg.version} — ${target}\n\nRun ./ctx --repo /path/to/project to open the terminal interface. The installation directory is not a task target. No Node.js or pnpm installation is needed.\nOptional: ./install.sh --upgrade updates an existing installation and retains backups.\n./install.sh installs ctx under ~/.local; ./install.sh /custom/prefix chooses another prefix.\n\nRequires a compatible glibc Linux system, Git, and Docker access for sandboxed verification.\nSecurity scanning also requires Python 3.10+ (tomli on Python 3.10) and provider authentication/access.\nUse ./ctx login to sign in and ./ctx doctor to inspect prerequisites.\nExisting provider authentication is reused; no credentials are included in this archive.\n\nDescribe a task, /repo chooses a project, /help lists commands.\nAuto mode verifies simple filesystem tasks directly; application checks prefer Docker. Host fallback requires explicit approval via /retry host or /set fallback on. /set pull on explicitly permits image downloads.\n/set install on explicitly permits frozen dependency installation. /security starts a separate security scan.\nSecurity scans have a $1 estimated budget; this is not a billing cap. Security unavailability is never a pass.\nThe original project is preserved; /diff reviews changes in the private task worktree.\n\nThird-party package names, versions and licenses: release-manifest.json and each package's license files.\nNode.js license: runtime/LICENSE. This release is a development build.\n`);
async function validateLinks(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      const resolved = await realpath(path); const rel = relative(stage, resolved);
      if (rel === '..' || rel.startsWith(`..${sep}`)) throw new Error(`Non-portable external package symlink: ${path}`);
    } else if (entry.isDirectory()) await validateLinks(path);
  }
}
await validateLinks(stage);
const smoke = await exec(join(stage, 'ctx'), ['--version'], { cwd: stage });
if (smoke.stdout.trim() !== `ctx ${pkg.version}`) throw new Error('Release launcher/version smoke test failed');
await exec('python3', [join(root, 'scripts', 'verify-terminal.py'), join(stage, 'ctx'), join(stage, 'examples', 'hello'), 'quit'], { timeout: 60_000, maxBuffer: 1_000_000 });
const output = join(root, 'releases'); await mkdir(output, { recursive: true });
const archiveOutput = join(output, `${name}.tar.gz`);
await exec('tar', ['-czf', archiveOutput + '.partial', '-C', build, name]);
await rename(archiveOutput + '.partial', archiveOutput);
const checksum = createHash('sha256').update(await readFile(archiveOutput)).digest('hex');
await writeFile(archiveOutput + '.sha256', `${checksum}  ${name}.tar.gz\n`);
await rm(join(output, name), { recursive: true, force: true }); await rename(stage, join(output, name));
await rm(build, { recursive: true, force: true });
console.log(`Release: ${archiveOutput}\nSHA-256: ${checksum}`);
