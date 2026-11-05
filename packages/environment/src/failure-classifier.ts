import type { FailureKind } from './types.js';
export function classifyFailure(output: string): { kind: FailureKind; reason: string } {
  let kind: FailureKind = 'unknown';
  if (/(?:ECONNREFUSED|ENOTFOUND|connection refused|could not connect|connection to server.*failed)/i.test(output) && /(?:postgres|5432|PGHOST|DATABASE_URL)/i.test(output)) kind = 'postgres-unavailable';
  else if (/(?:ECONNREFUSED|ENOTFOUND|connection refused)/i.test(output) && /(?:mock|:8080)/i.test(output)) kind = 'mock-unavailable';
  else if (/(?:ENOENT|missing|not found|cannot find|could not find)[^\n]*\.env\b|\.env[^\n]*(?:ENOENT|missing|not found)/i.test(output)) kind = 'missing-env';
  else if (/(?:missing|required|not set|not configured)[^\n]*(?:API[_ -]?KEY|ACCESS[_ -]?TOKEN)|(?:API[_ -]?KEY|ACCESS[_ -]?TOKEN)[^\n]*(?:missing|required|not set|not configured)/i.test(output)) kind = 'missing-api-key';
  else if (/Cannot find (?:package|module) ['"](?:@[^/'"\s]+\/)?[^./'"\s][^'"\s]*['"]|ERR_MODULE_NOT_FOUND[^\n]*package|(?:tsc|vite|vitest|jest): (?:command )?not found/i.test(output)) kind = 'missing-dependency';
  else if (/EADDRINUSE|address already in use/i.test(output)) kind = 'port-in-use';
  else if (/Executable doesn't exist[^\n]*(?:playwright|chrom)|playwright install|browser executable[^\n]*not found/i.test(output)) kind = 'browser-unavailable';
  return { kind, reason: output.split('\n').filter(Boolean).slice(-12).join('\n').slice(-4000) };
}
