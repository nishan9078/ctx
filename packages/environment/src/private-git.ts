import { AsyncLocalStorage } from 'node:async_hooks';
import { OwnedCommandSession } from './owned-command-session.js';
import { runOwnedCommand } from './owned-command.js';
const sessions = new AsyncLocalStorage<OwnedCommandSession>();
const gitEnvironment = () => ({ ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' });
export async function privateGitScope<T>(work: () => Promise<T>): Promise<T> {
  if (sessions.getStore()) return work();
  const session = new OwnedCommandSession({ env: gitEnvironment() });
  return sessions.run(session, async () => { try { return await work(); } finally { await session.close(); } });
}
/** Private snapshot operations must not inherit Git-dir overrides, hooks or global filters. */
export function privateGit(args: string[], cwd: string, signal?: AbortSignal) {
  const options = ['--no-pager', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.attributesFile=/dev/null', ...args];
  const session = sessions.getStore();
  return session ? session.run('git', options, cwd, signal) : runOwnedCommand('git', options, cwd, { signal, env: gitEnvironment() });
}

export async function assertPrivateGitSafe(workspace: string): Promise<void> {
  const { CtxError } = await import('../../shared/src/errors.js');
  const configuration = await privateGit(['config', '--local', '--no-includes', '--null', '--list'], workspace);
  if (configuration.code !== 0 || configuration.truncated || configuration.output.split('\0').some(entry => /^(?:filter\.|include(?:if\.|\.)|core\.(?:worktree|sshcommand)|extensions\.worktreeconfig)/i.test(entry.split('\n')[0]))) throw new CtxError('UNAUTHORIZED', 'Private Git configuration contains unsafe overrides');
  const root = await privateGit(['rev-parse', '--show-toplevel'], workspace);
  if (root.code !== 0 || root.output.trim() !== workspace) throw new CtxError('UNAUTHORIZED', 'Git working directory escapes its ownership');
}
