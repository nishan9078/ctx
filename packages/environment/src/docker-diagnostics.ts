import { readFile, stat } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { EnvironmentUnavailable } from './types.js';

export interface DockerAccessFacts {
  uid?: number;
  gid?: number;
  groups: number[];
  username?: string;
  userNamespaceRestricted?: boolean;
  noNewPrivileges?: boolean;
  socket?: { path: string; uid: number; gid: number; mode: number; group?: string; configuredMember?: boolean };
}
export interface DockerAccessDiagnostic {
  kind: 'stale-session-groups' | 'socket-permission-denied' | 'daemon-unavailable' | 'image-missing' | 'container-startup-failed';
  operation: string;
  facts: DockerAccessFacts;
  recommendation: string;
}
export class DockerEnvironmentError extends EnvironmentUnavailable {
  override name = 'DockerEnvironmentError';
  constructor(message: string, readonly diagnostic: DockerAccessDiagnostic) { super(`${message}\n${diagnostic.recommendation}`); }
}
export function dockerFailure(kind: DockerAccessDiagnostic['kind'], operation: string, message: string, recommendation: string): DockerEnvironmentError {
  return new DockerEnvironmentError(message, { kind, operation, recommendation, facts: { uid: process.getuid?.(), gid: process.getgid?.(), groups: process.getgroups?.() ?? [] } });
}
export class DockerAccessError extends DockerEnvironmentError {
  override name = 'DockerAccessError';
  constructor(message: string, diagnostic: DockerAccessDiagnostic) {
    super(message, diagnostic);
  }
}
export function classifyDockerAccess(facts: DockerAccessFacts, operation: string): DockerAccessDiagnostic {
  const socket = facts.socket;
  const activeGroups = new Set([facts.gid, ...facts.groups]);
  const ownerCanWrite = socket && socket.uid === facts.uid && (socket.mode & 0o200) !== 0;
  const groupNeeded = socket && (socket.mode & 0o020) !== 0 && (socket.mode & 0o002) === 0 && !ownerCanWrite;
  if (!facts.userNamespaceRestricted && socket?.configuredMember && groupNeeded && !activeGroups.has(socket.gid)) {
    return {
      kind: 'stale-session-groups', operation, facts,
      recommendation: `Account ${facts.username ?? facts.uid} is already configured in ${socket.group ?? 'the socket group'} (GID ${socket.gid}), but this process's groups [${[...activeGroups].filter(value => value !== undefined).join(', ')}] do not include it. Log out and back in, then fully restart the terminal/Codex runner from that refreshed login session. A child process or a new shell inside this stale runner cannot refresh inherited groups. No socket permission change is needed.`,
    };
  }
  return {
    kind: 'socket-permission-denied', operation, facts,
    recommendation: facts.userNamespaceRestricted
      ? 'Docker access was denied in a restricted user namespace. Run the orchestrator only in an explicitly authorized execution context with Docker access; keep coding and verification sandboxes restricted. The harness will not escape the sandbox or change socket permissions.'
      : `Docker socket access is denied for this running process${socket ? ` (socket UID ${socket.uid}, GID ${socket.gid}, mode ${socket.mode.toString(8)})` : ''}. Check the current process groups and the approved Docker endpoint with your administrator. Do not make the socket world-writable or grant workloads Docker access.`,
  };
}
export function isDockerAccessDenied(output: string): boolean {
  return /(?:permission denied|operation not permitted)/i.test(output) && /(?:docker (?:API|daemon)|docker\.sock|unix:\/\/)/i.test(output);
}
export async function diagnoseDockerAccess(output: string, operation: string): Promise<DockerAccessDiagnostic> {
  const facts: DockerAccessFacts = { uid: process.getuid?.(), gid: process.getgid?.(), groups: process.getgroups?.() ?? [] };
  try { facts.username = userInfo().username; } catch { /* Account lookup is not universally available. */ }
  const optionalRead = (path: string) => readFile(path, 'utf8').catch(() => undefined);
  const [groupFile, gidMap, status] = await Promise.all([optionalRead('/etc/group'), optionalRead('/proc/self/gid_map'), optionalRead('/proc/self/status')]);
  if (gidMap) facts.userNamespaceRestricted = !gidMap.trim().split('\n').some(line => {
    const [inside, outside, length] = line.trim().split(/\s+/).map(Number);
    return inside === 0 && outside === 0 && length >= 4294967295;
  });
  const noNewPrivileges = status?.match(/^NoNewPrivs:\s*(\d+)/m);
  if (noNewPrivileges) facts.noNewPrivileges = noNewPrivileges[1] === '1';
  // Use the endpoint named by the actual CLI error, not an assumed default or
  // a different saved context. Never read Docker config/auth files for diagnostics.
  const path = (output.match(/unix:\/\/(\/[^\s"')]+)/)?.[1] ?? output.match(/dial unix (\/[^\s:]+)/)?.[1])?.replace(/[:,;]+$/, '');
  if (path) {
    try {
      const socket = await stat(path);
      const entry = groupFile?.split('\n').map(line => line.split(':')).find(fields => Number(fields[2]) === socket.gid);
      facts.socket = { path, uid: socket.uid, gid: socket.gid, mode: socket.mode & 0o777,
        group: entry?.[0], configuredMember: entry && facts.username ? entry[3]?.split(',').includes(facts.username) : undefined };
    } catch { /* Preserve the original Docker error when socket metadata is inaccessible. */ }
  }
  return classifyDockerAccess(facts, operation);
}
