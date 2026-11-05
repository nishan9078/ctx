import { stripVTControlCharacters } from 'node:util';
import type { TaskRecord } from '../../../packages/core/src/types.js';
import type { Report } from '../../../packages/shared/src/contracts.js';
import type { SecurityResult } from '../../../packages/security/src/security-adapter.js';
export const safeText = (value: unknown): string => stripVTControlCharacters(String(value)).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
export function taskProgress(task: TaskRecord): string {
  const stages: Record<string, string> = { queued: 'Queued', planning: 'Planning', preparing: 'Preparing workspace', executing: 'Implementing request', verifying: 'Running checks', repairing: 'Repairing changes', awaiting_approval: 'Waiting for approval', completed: 'Completed', failed: 'Failed', blocked: 'Needs attention', cancelled: 'Cancelled' };
  const step = task.plan.steps.find(item => item.status === 'running');
  const checks = task.verification.map(check => `${check.name}: ${check.status}`).join(' · ');
  return `${stages[task.status] ?? 'Working'}${step ? ` · ${safeText(step.title)}` : ''}${checks ? ` · ${checks}` : ''}`;
}
export function reportView(report: Report): string {
  const checks = report.verification.map(check => `  ${check.name.padEnd(10)} ${check.status}`).join('\n');
  const summary = report.outcome === 'completed' ? 'Changes are ready for review.' : report.environment.diagnostic ? 'Docker is unavailable to this running session. See /details for the access diagnostic.' : 'The task stopped before all required checks passed. Use /details to inspect the evidence.';
  return `${report.outcome.toUpperCase()}\n${summary}\n${checks || '  Checks     not run'}\n  Security   not run (use /security)\n\n  Workspace  ${safeText(report.workspacePath ?? 'unavailable')}\n  Report     ${safeText(report.implemented.diff.replace(/changes\.diff$/, 'report.md'))}\n\nUse /diff to review changes. Your original repository was not changed.`;
}
export function securityView(result: SecurityResult): string {
  return `Security: ${result.status}\n${result.findings.map(finding => `  ${finding.severity.toUpperCase()}  ${safeText(finding.title)}${finding.file ? ` (${safeText(finding.file)}${finding.line ? `:${finding.line}` : ''})` : ''}`).join('\n') || (result.status === 'passed' ? '  No findings reported in the returned scan results.' : '  Scan did not complete; no security conclusion is available.')}\nCoverage: ${result.coverage.map(safeText).join(', ') || 'unverified'}\n${result.limitations.length ? `Limitations: ${result.limitations.length} (see /details)` : ''}${result.reportPath ? `\nReport: ${safeText(result.reportPath)}` : ''}`;
}
export const terminalHelp = `Describe a change to start a task. Commands:
  /repo <path>       Choose a repository
  /tasks             List recent tasks
  /status [id]       Inspect the current or a saved task
  /resume <id>       Resume a safely recoverable task
  /diff [id]         Show the saved patch
  /details [id]      Show technical evidence and diagnostics
  /security          Scan the last task's workspace (or selected repository)
  /login             Sign in to the connected provider
  /config            Show current settings
  /set execution docker|host
  /set repairs 0..10
  /set pull on|off    Permit image downloads
  /set install on|off Permit frozen dependency installation
  /set build <cmd>   Override the build command
  /set test <cmd>    Override the test command
  /cancel            Stop the active task or security scan
  /quit              Exit
  Ctrl-C             Cancel active work; press again to exit`;
