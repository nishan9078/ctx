import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CommandRunner } from '../../environment/src/types.js';
import { EnvironmentUnavailable } from '../../environment/src/types.js';
import type { CheckResult } from '../../shared/src/contracts.js';
import { redact } from '../../shared/src/redact.js';
import { verifyAcceptance, type VerificationPolicy } from './policy.js';
import type { VerificationPlan, PlannedCheck } from './planner.js';
import { artifactsCheck, syntaxCheck } from './checks.js';
export const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
export function requiredChecksPass(checks: CheckResult[]): boolean { const required = checks.filter(check => (check.requirement ?? 'mandatory') === 'mandatory'); return required.length > 0 && required.every(check => check.status === 'passed'); }
export function missingRequired(checks: CheckResult[]): CheckResult[] { return checks.filter(check => (check.requirement ?? 'mandatory') === 'mandatory' && check.status === 'unavailable'); }
export async function executeVerificationPlan(workspace: string, artifacts: string, plan: VerificationPlan, policy: VerificationPolicy, signal: AbortSignal | undefined, timeoutMs: number | undefined,
  hooks: { existing?: CheckResult[]; before?: (name: string) => void; after?: (check: CheckResult) => void } | undefined, runner?: CommandRunner): Promise<CheckResult[]> {
  const checks: CheckResult[] = [];
  for (const descriptor of plan.checks) {
    const existing = hooks?.existing?.find(check => check.name === descriptor.id); if (existing) { checks.push(existing); continue; }
    signal?.throwIfAborted(); hooks?.before?.(descriptor.id);
    const started = Date.now(); let status: CheckResult['status'] = 'unavailable'; let code: number | null = null; let output = ''; let infrastructure: EnvironmentUnavailable | undefined;
    let command = descriptor.command ?? `CTX ${descriptor.kind}: ${JSON.stringify(descriptor.paths)}`;
    const limitations: string[] = [];
    try {
      if (descriptor.requirement === 'not-applicable') { status = 'not-applicable'; output = descriptor.reason; }
      else if (descriptor.kind === 'command' || descriptor.kind === 'browser') {
        let unavailableReason: string | undefined;
        if (!descriptor.command && descriptor.kind === 'browser') {
          if (!descriptor.paths.length) unavailableReason = 'Browser smoke unavailable: no HTML entry point or configured browser command.';
          else if (!runner?.supportsBuiltInBrowser) unavailableReason = 'Browser smoke unavailable: built-in browser execution requires explicit host permission and an installed Chromium. Docker browser checks require a configured command in the selected image. No isolation downgrade or download was attempted.';
          else {
            const worker = resolve(dirname(fileURLToPath(import.meta.url)), 'browser-worker.js');
            command = `${quote(process.execPath)} ${quote(worker)} ${quote(join(workspace, descriptor.paths[0]))} ${quote(join(artifacts, 'browser.png'))}`;
          }
        } else if (!descriptor.command) unavailableReason = `Required ${descriptor.id} check unavailable: no command or configured runner exists. Set the corresponding explicit verification command.`;
        if (unavailableReason) { output = unavailableReason; limitations.push(unavailableReason); }
        else if (!runner || runner.canExecuteCommands === false) { output = 'Required execution backend unavailable; no project command ran.'; }
        else {
          const result = await runner.run(command, signal, timeoutMs); code = result.code; output = result.output;
          const absent = descriptor.kind === 'browser' && (code === 78 || /Executable doesn't exist|Cannot find module.*playwright|browser.*(?:not found|unavailable)/i.test(output));
          status = absent || result.code === 127 || /Missing script:\s*["']/.test(output) ? 'unavailable' : result.code === 0 && !result.timedOut ? 'passed' : 'failed';
          if (result.timedOut) output += '\nCheck timed out.';
          if (absent) limitations.push('Browser runtime was unavailable; no browser coverage is established.');
        }
        if (descriptor.kind === 'browser') limitations.push('Syntax checking is separate. This smoke test does not prove complete gameplay or visual correctness.');
      } else {
        const result = descriptor.kind === 'acceptance' ? await verifyAcceptance(workspace, policy.criteria)
          : descriptor.kind === 'documentation' ? await verifyAcceptance(workspace, descriptor.paths.map(path => ({ kind: 'markdown', path })))
          : descriptor.kind === 'syntax' ? await syntaxCheck(workspace, descriptor.paths, artifacts, signal)
          : await artifactsCheck(workspace, descriptor.paths, descriptor.absentPaths);
        output = result.output; code = result.passed ? 0 : 1; status = 'unavailable' in result && result.unavailable ? 'unavailable' : result.passed ? 'passed' : 'failed';
        if (descriptor.kind === 'syntax') limitations.push('Syntax only; runtime and browser behavior unverified by this check.');
      }
    } catch (error) { output = String(error); status = error instanceof EnvironmentUnavailable ? 'unavailable' : 'failed'; if (error instanceof EnvironmentUnavailable) infrastructure = error; }
    if (signal?.aborted) status = 'cancelled';
    const requirement = descriptor.kind === 'browser' && descriptor.requirement === 'optional' && ['passed', 'failed'].includes(status) ? 'mandatory' : descriptor.requirement;
    const reason = requirement !== descriptor.requirement ? descriptor.reason + '; browser execution was available, so observed runtime results are mandatory' : descriptor.reason;
    const artifact = join(artifacts, `${descriptor.id}.log`);
    await writeFile(artifact, redact(`${requirement.toUpperCase()} ${descriptor.id}\nReason: ${reason}\nCommand: ${command}\nExit code: ${code}\nStatus: ${status}\n\n${output}\n${limitations.join('\n')}\n`));
    const check: CheckResult = { name: descriptor.id, requirement, reason, command, status, exitCode: code, durationMs: Date.now() - started, artifact, limitations };
    checks.push(check); hooks?.after?.(check); if (infrastructure && descriptor.requirement === 'mandatory') throw infrastructure;
  }
  if (!checks.some(check => check.requirement === 'mandatory')) throw new Error('No independent mandatory checks; refusing vacuous completion');
  return checks;
}
