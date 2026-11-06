import { spawn } from 'node:child_process';
import { access, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const runtime = resolve('releases', `ctx-${process.platform}-${process.arch}`, 'runtime', 'bin', 'node');
try { await access(runtime); } catch { throw new Error('Build the bundled runtime first with pnpm release.'); }
const files = (await readdir('dist/tests/tui')).filter(name => name.endsWith('.test.js')).map(name => join('dist/tests/tui', name));
// The native renderer replaces console output while attached. Keep the Node test
// reporter in this process rather than sending its binary protocol through it.
const child = spawn(runtime, ['--experimental-ffi', '--disable-warning=ExperimentalWarning', '--test', '--test-isolation=none', ...files], { stdio: 'inherit' });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
