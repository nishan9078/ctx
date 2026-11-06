import { readFileSync, readlinkSync } from 'node:fs';
import { hostname } from 'node:os';
export function processIdentity(pid = process.pid): string {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const start = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
    return `${readlinkSync(`/proc/${pid}/ns/pid`)}|${readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()}:${start}`;
  } catch { return 'unknown'; }
}
export function ownerState(pid: number, host: string, start: string): 'alive' | 'dead' | 'unknown' {
  if (host !== hostname() || pid <= 0) return 'unknown';
  if (process.platform === 'linux') {
    const current = processIdentity(); if (current === 'unknown' || start === 'unknown') return 'unknown';
    const [namespace, identity] = start.split('|'); const [currentNamespace, currentIdentity] = current.split('|');
    if (!identity || !currentIdentity) return 'unknown';
    if (identity.split(':')[0] !== currentIdentity.split(':')[0]) return 'dead'; // Previous host boot cannot retain a worker.
    if (namespace !== currentNamespace) return 'unknown'; // PID numbers are not comparable across namespaces.
  }
  try { process.kill(pid, 0); } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'unknown'; }
  const observed = processIdentity(pid);
  if (observed !== 'unknown' && start !== 'unknown' && observed !== start) return 'dead';
  return 'alive';
}
