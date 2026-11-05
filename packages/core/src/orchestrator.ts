import { redact } from '../../shared/src/redact.js';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, appendFile, mkdtemp, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentAdapter, AgentResult } from '../../agents/src/agent-adapter.js';
import type { Report } from '../../shared/src/contracts.js';
import { prepareWorkspace, captureDiff } from '../../environment/src/workspace.js';
import { discoverCommands, verify } from '../../verification/src/verifier.js';
export interface RunInput {
  request: string; repositoryPath: string; outputDirectory?: string;
  build?: string; test?: string; signal?: AbortSignal; timeoutMs?: number;
}
export async function runTask(input: RunInput, agent: AgentAdapter): Promise<{ report: Report; directory: string }> {
  if (!input.request.trim()) throw new Error('Request must not be empty');
  const repositoryPath = await realpath(input.repositoryPath);
  const id = randomUUID(); const started = Date.now();
  const directory = resolve(input.outputDirectory ?? join(repositoryPath, '.harness'), id);
  await mkdir(directory, { recursive: true });
  const eventFile = join(directory, 'events.jsonl');
  let sequence = 0;
  const event = async (type: string, data: unknown) => { await appendFile(eventFile, redact(JSON.stringify({ sequence: ++sequence, timestamp: new Date().toISOString(), type, data })) + '\n'); };
  const report: Report = {
    id, request: redact(input.request), repositoryPath, outcome: 'failed',
    implemented: { summary: '', diff: join(directory, 'changes.diff'), hasChanges: false }, verification: [],
    security: { status: 'unavailable', coverage: [] },
    environment: { dependencies: 'Source files copied; no dependencies provisioned and no mocks created.', resources: [] },
    limitations: ['Milestone 1: no security scanners, durable resume, repair attempts, or external integration verification.', 'Verification commands run locally on the host. Use only trusted repositories and commands; container isolation arrives in Milestone 3.'],
    usage: { elapsedMs: 0, agentTurns: 0, retries: 0 }, nextActions: [],
  };
  await writeFile(join(directory, 'task.json'), redact(JSON.stringify({ ...input, signal: undefined, id, repositoryPath, status: 'queued' }, null, 2)));
  const controller = new AbortController();
  const abort = () => controller.abort(input.signal?.reason);
  input.signal?.addEventListener('abort', abort, { once: true });
  if (input.signal?.aborted) abort();
  const timer = setTimeout(() => controller.abort(new Error('Task timed out')), input.timeoutMs ?? 600_000);
  let temporary: string | undefined;
  try {
    await event('task.preparing', { repositoryPath });
    const commands = await discoverCommands(repositoryPath, input);
    temporary = await mkdtemp(join(tmpdir(), 'harness-'));
    report.workspacePath = await prepareWorkspace(repositoryPath, join(temporary, 'workspace'));
    report.environment.resources.push(report.workspacePath);
    await event('task.executing', { workspacePath: report.workspacePath, commands });
    report.usage.agentTurns = 1;
    const result: AgentResult = await agent.execute({
      workspacePath: report.workspacePath, signal: controller.signal,
      prompt: `Implement this request in the current workspace:\n${redact(input.request)}\n\nPreserve existing work. Do not deploy, contact external services, use credentials, or modify files outside this workspace. Do not commit or change Git metadata. Build/test commands: ${JSON.stringify(commands)}. Summarize changes and limitations.`,
      onEvent: async item => { await event(`agent.${item.type}`, item.data); },
    });
    if (!['completed', 'failed', 'interrupted'].includes(result.outcome) || typeof result.summary !== 'string') throw new Error('Invalid agent result');
    report.sessionId = result.sessionId; report.implemented.summary = redact(result.summary); report.usage.tokens = result.usage;
    await event('agent.result', result);
    if (result.outcome === 'completed' && !controller.signal.aborted) {
      await event('task.verifying', commands);
      report.verification = await verify(report.workspacePath, directory, commands, controller.signal, input.timeoutMs);
      report.outcome = report.verification.every(check => check.status === 'passed') ? 'completed'
        : report.verification.some(check => check.status === 'unavailable') ? 'blocked' : 'failed';
    } else report.outcome = result.outcome === 'interrupted' ? 'cancelled' : 'failed';
  } catch (error) {
    report.implemented.summary = redact(String(error));
    await event('task.error', { message: String(error) });
  } finally {
    clearTimeout(timer); input.signal?.removeEventListener('abort', abort);
    if (controller.signal.aborted) report.outcome = input.signal?.aborted ? 'cancelled' : 'failed';
    try {
      const diff = report.workspacePath ? await captureDiff(report.workspacePath) : '';
      report.implemented.hasChanges = diff.length > 0;
      await writeFile(report.implemented.diff, diff);
    } catch (error) { report.outcome = 'failed'; report.limitations.push(`Diff capture failed: ${String(error)}`); }
    if (report.outcome !== 'completed') report.nextActions.push('Inspect evidence logs, resolve the reported failure or missing checks, and start a new run.');
    report.usage.elapsedMs = Date.now() - started;
    await event('task.finished', { outcome: report.outcome });
    await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    await writeFile(join(directory, 'report.md'), renderReport(report));
  }
  return { report, directory };
}
function renderReport(report: Report): string {
  return `# Task ${report.id}\n\nOutcome: ${report.outcome}\n\n${report.implemented.summary}\n\nDiff: ${report.implemented.diff}\nWorkspace: ${report.workspacePath ?? 'unavailable'}\n\n## Verification\n\n${report.verification.map(check => `- ${check.name}: ${check.status}; command: ${JSON.stringify(check.command)}; ${check.durationMs}ms; evidence: ${check.artifact}`).join('\n') || 'No checks ran.'}\n\n## Security\n\nUnavailable; no scanners ran.\n\n## Environment\n\n${report.environment.dependencies}\n\n## Limitations\n\n${report.limitations.map(item => `- ${item}`).join('\n')}\n\n## Usage\n\n${JSON.stringify(report.usage)}\n\n## Next actions\n\n${report.nextActions.join('\n') || 'None.'}\n`;
}
