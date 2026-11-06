import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Phase 04 probe (P04-01).
 * Reports actual Codex CLI + SDK versions and credential presence without
 * printing secrets and without ever running a generation.
 * Model/provider are reported as unknown: they cannot be known without a
 * generation, and must never be invented.
 */
export type AuthPresence = 'auth-file' | 'env' | 'none' | 'unknown';
export interface CodexReadiness {
  sdkVersion: string;
  cliVersion: string;
  cliAvailable: boolean;
  auth: AuthPresence;
  model: 'unknown';
  provider: 'unknown';
  /** Human-readable diagnostics; never contains credential values. */
  probeErrors: string[];
}
export interface ProbeCommandResult { code: number | null; output: string; error?: string }
export interface CodexProbeOptions {
  env?: NodeJS.ProcessEnv;
  /** Codex home directory; defaults to CODEX_HOME or ~/.codex. */
  homeDir?: string;
  /** Synthetic command runner used for deterministic tests. */
  run?: (command: string, args: string[]) => Promise<ProbeCommandResult>;
  sdkVersion?: string;
  timeoutMs?: number;
}

const envCredentialKeys = ['CODEX_API_KEY', 'OPENAI_API_KEY'] as const;

function defaultRun(command: string, args: string[], timeoutMs: number): Promise<ProbeCommandResult> {
  return new Promise(resolve => {
    try {
      const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
      let output = '';
      const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } resolve({ code: null, output, error: 'probe timed out' }); }, timeoutMs);
      const collect = (data: Buffer) => { output = (output + data.toString()).slice(-8192); };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      child.on('error', error => { clearTimeout(timer); resolve({ code: null, output: '', error: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'CLI executable not found in PATH' : 'CLI spawn failed' }); });
      child.on('close', code => { clearTimeout(timer); resolve({ code, output }); });
    } catch {
      resolve({ code: null, output: '', error: 'CLI spawn threw' });
    }
  });
}

function installedSdkVersion(): string {
  try {
    // The SDK exports only its ESM entrypoint, not package.json.
    const entry = import.meta.resolve('@openai/codex-sdk');
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', entry)), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' && pkg.version.length > 0 ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

export async function probeCodex(options: CodexProbeOptions = {}): Promise<CodexReadiness> {
  const env = options.env ?? process.env;
  const probeErrors: string[] = [];
  const sdkVersion = options.sdkVersion ?? installedSdkVersion();
  if (sdkVersion === 'unknown') probeErrors.push('Could not resolve installed @openai/codex-sdk version');
  const timeoutMs = options.timeoutMs ?? 10_000;
  const run = options.run ?? ((cmd: string, args: string[]) => defaultRun(cmd, args, timeoutMs));
  let cliVersion = 'unknown';
  let cliAvailable = false;
  try {
    const result = await run('codex', ['--version']);
    if (result.error) {
      probeErrors.push(`codex --version failed: ${result.error}`);
    } else if (result.code !== 0) {
      probeErrors.push(`codex --version exited with code ${String(result.code)}`);
    } else {
      const version = result.output.split(/\r?\n/).map(line => line.trim()).find(line => /^codex-cli \d+\.\d+\.\d+(?:[^\s]*)?$/.test(line)) ?? '';
      if (!version) probeErrors.push('codex --version produced no version output');
      else { cliVersion = version; cliAvailable = true; }
    }
  } catch {
    probeErrors.push('codex --version threw');
  }
  // Credential presence without reading values: env key presence or auth file existence.
  let auth: AuthPresence = 'none';
  if (envCredentialKeys.some(key => typeof env[key] === 'string' && (env[key] as string).length > 0)) {
    auth = 'env';
  } else {
    const home = options.homeDir ?? env.CODEX_HOME ?? join(homedir(), '.codex');
    try {
      const info = await lstat(join(home, 'auth.json'));
      if (info.isFile()) auth = 'auth-file';
    } catch {
      auth = 'none';
    }
  }
  return { sdkVersion, cliVersion, cliAvailable, auth, model: 'unknown', provider: 'unknown', probeErrors };
}
