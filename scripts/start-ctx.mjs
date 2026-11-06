import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
const runtime = resolve('releases', `ctx-${process.platform}-${process.arch}`, 'runtime', 'bin', 'node');
let executable = runtime;
try { await access(runtime); } catch {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 26 || major === 26 && minor < 4) throw new Error('Run pnpm release first to build the OpenTUI runtime, or use pnpm harness --plain explicitly.');
  executable = process.execPath;
}
const child = spawn(executable, ['--experimental-ffi', '--disable-warning=ExperimentalWarning', resolve('dist/apps/cli/src/index.js'), ...process.argv.slice(2)], { stdio: 'inherit' });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
