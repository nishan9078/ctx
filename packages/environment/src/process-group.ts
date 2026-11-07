import { readdirSync, readFileSync } from 'node:fs';
/** Linux live process-group membership, excluding zombies that cannot execute work. */
export function liveProcessGroup(pgid: number): number[] {
  const members: number[] = [];
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8'); const fields = stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/);
      if (Number(fields[2]) === pgid && fields[0] !== 'Z' && fields[0] !== 'X') members.push(Number(name));
    } catch (error) { if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
  }
  return members;
}
