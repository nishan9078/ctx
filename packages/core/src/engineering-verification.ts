import { mkdir, readFile, open } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CommandActor } from '../../shared/src/domain.js';
import type { LeaseClaim } from '../../shared/src/scheduling.js';
import type { GateReport, GateStep, GateStepResult, GateStatus, VerificationProfile } from '../../shared/src/verification-profile.js';
import { gateReportStatus } from '../../shared/src/verification-profile.js';
import type { TreeEntry } from '../../environment/src/workspace-tree.js';
import { workspaceTree } from '../../environment/src/workspace-tree.js';
import { privateGit, privateGitScope } from '../../environment/src/private-git.js';
import { syntaxCheck } from '../../verification/src/checks.js';
import { verifyAcceptance } from '../../verification/src/policy.js';
import { scopeCheck, testIntegrityCheck, changedTreePaths, pathMatches, verifyTestSummary } from '../../verification/src/profile-checks.js';
import { scanSecrets, scanDependencies, type BaselineScan } from '../../security/src/baseline-scanners.js';
import { CodexSecurityAdapter } from '../../security/src/codex-security.adapter.js';
import type { SecurityAdapter } from '../../security/src/security-adapter.js';
import type { WorkerRuntimeBudget } from '../../shared/src/runtime.js';
import { ArtifactStore } from '../../persistence/src/artifact-store.js';
import { ordinaryDirectory, readJsonFile, syncPath } from '../../persistence/src/artifact-files.js';
import type { TaskRepository } from '../../persistence/src/task-repository.js';
import { CtxError } from '../../shared/src/errors.js';
import { OwnedWorkspaces } from './owned-workspaces.js';
import { runProfileCommand, trackedVerificationExecutor, type VerificationBackend } from './verification-execution.js';
export interface VerificationOptions { backend?: VerificationBackend; securityAdapter?: SecurityAdapter; runtime?: Partial<WorkerRuntimeBudget> }
export function renderVerificationReport(report: GateReport): string {
  return `# Verification report: ${report.taskId}\n\nVerification: **${report.status}**\nAttempt: ${report.attemptId}\nProfile: ${report.profileId} (${report.profileHash ?? 'unavailable'})\nBase: ${report.baseSha ?? 'unavailable'}\nResult commit: ${report.resultSha ?? 'unavailable'}\n\nTask disposition is authoritative in durable task details; passing checks do not override cancellation.\n\n| Check | Required | Result | Observed | Exit | Waiver |\n| --- | --- | --- | --- | ---: | --- |\n${report.steps.map(step => `| ${step.id} | ${step.required} | ${step.status} | ${step.observedStatus} | ${step.exitCode ?? '-'} | ${step.waiverId ?? '-'} |`).join('\n')}\n\n## Evidence\n\n${report.steps.map(step => `- ${step.id}: stdout ${step.stdoutArtifactId}; stderr ${step.stderrArtifactId}; backend ${step.environment.backend}; ${step.durationMs}ms; command ${JSON.stringify(step.command ?? [])}`).join('\n')}\n\n## Findings\n\n${report.steps.flatMap(step => step.findings.map(finding => `- ${finding.severity}: ${finding.scanner}: ${finding.message}; file ${finding.path ?? '-'}:${finding.line ?? '-'}`)).join('\n') || 'No findings recorded; coverage is limited to the configured executed checks.'}\n\n## Limitations\n\n${[...new Set([...report.limitations, ...report.steps.flatMap(step => step.limitations)])].map(line => `- ${line}`).join('\n')}\n`;
}
export async function verifyEngineeringAttempt(repository: TaskRepository, claim: LeaseClaim, actor: CommandActor, signal: AbortSignal, options: VerificationOptions = {}, input: { harnessOutcome?: GateReport['harnessOutcome']; reason?: string; reconciled?: boolean } = {}): Promise<GateReport> {
  const frozen = repository.verification.frozen(claim.attempt.id) ?? (input.reconciled ? repository.verification.bindHistoricalMissing(claim, actor) : repository.verification.bind(claim, actor));
  const id = randomUUID(); const startedAt = new Date().toISOString(); const harnessOutcome = input.harnessOutcome ?? 'completed';
  const directory = join(repository.dataDirectory, 'verification', claim.attempt.id, id); await ordinaryDirectory(directory, true);
  const store = await ArtifactStore.open(repository.dataDirectory); const manager = new OwnedWorkspaces(repository);
  const profile = frozen.profile; const steps: GateStepResult[] = []; const limitations = ['Agent-reported results are not independent verification evidence. Host execution, when explicitly selected by the owner, is not container isolation.', 'Security passes describe only configured scan coverage; no complete vulnerability or live-integration guarantee is implied.'];
  let owned: Awaited<ReturnType<OwnedWorkspaces['assertOwned']>> | undefined; let baseline: TreeEntry[] = []; let current: TreeEntry[] = []; let verificationInput: TreeEntry[] = []; let fatal: unknown = input.reconciled ? new CtxError('ENVIRONMENT_UNAVAILABLE', 'Recovered partial evidence; verification was not replayed') : undefined; let resultSha: string | undefined;
  const published: string[] = [];
  const save = async (kind: string, content: string) => { const artifact = await store.writeText({ taskId: claim.task.spec.id, ...(input.reconciled ? {} : { attemptId: claim.attempt.id }), kind, retention: kind.endsWith('-log') ? 'log' : 'evidence' }, content, repository, actor); published.push(artifact.id); return artifact.id; };
  const applyWaiver = (step: GateStep, result: GateStepResult) => { const waiver = repository.verification.applicableWaiver(claim, step.id); if (waiver && result.observedStatus !== 'passed' && result.observedStatus !== 'cancelled') { result.status = 'skipped_with_approval'; result.waiverId = waiver.id; result.limitations.push(`Owner waiver ${waiver.id}: ${waiver.reason}; live/failed coverage was not converted to passed.`); } };
  const guard = (step: GateStep): BaselineScan => step.kind === 'scope' ? scopeCheck(claim.task.spec, profile!, baseline, current) : step.kind === 'test_integrity' ? testIntegrityCheck(profile!, baseline, current) : scanSecrets(current);
  try {
    const workspaces = repository.workspaces.list().filter(workspace => workspace.taskId === claim.task.spec.id && workspace.state !== 'removed');
    const descriptor = repository.artifacts(claim.task.spec.id).find(artifact => artifact.attemptId === claim.attempt.id && artifact.kind === 'codex-workspace');
    if (descriptor && !input.reconciled) {
      await repository.verifyStoredArtifact(descriptor.id);
      const data = JSON.parse(await readFile(join(repository.dataDirectory, descriptor.location), 'utf8')) as { workspaceOwnerAttemptId: string; workspace: string };
      const candidate = workspaces.find(workspace => workspace.id === data.workspaceOwnerAttemptId);
      if (!candidate || candidate.identity.worktree !== data.workspace) throw new CtxError('CONFLICT', 'Verification workspace provenance changed');
      owned = await manager.assertOwned(candidate.id); repository.workspaces.assertAccess(claim, owned.id);
    }
    if (profile && harnessOutcome === 'completed' && !input.reconciled) {
      if (!owned) throw new CtxError('CONFLICT', 'No owned workspace for independent verification');
      const descriptor = repository.artifacts(claim.task.spec.id).find(artifact => artifact.attemptId === claim.attempt.id && artifact.kind === 'verification-baseline');
      if (!descriptor) throw new CtxError('CONFLICT', 'No immutable pre-harness baseline');
      await repository.verifyStoredArtifact(descriptor.id);
      const snapshot = await readJsonFile(join(repository.dataDirectory, descriptor.location), 16 * 1024 * 1024) as { workspaceId: string; baseSha: string; profileHash: string; taskSpecHash: string; entries: TreeEntry[] };
      if (snapshot.workspaceId !== owned.id || snapshot.baseSha !== owned.identity.baseSha || snapshot.profileHash !== frozen.profileHash || snapshot.taskSpecHash !== frozen.taskSpecHash) throw new CtxError('CONFLICT', 'Verification baseline does not match frozen task/profile/workspace');
      baseline = snapshot.entries; current = (await workspaceTree(owned.identity.worktree)).entries; verificationInput = current;
    }
  } catch (error) { fatal = error; }
  for (const step of profile?.steps ?? []) {
    const begin = Date.now(); let observed: GateStatus = 'not_run'; let output = ''; let stderr = ''; let exitCode: number | null = null; let timedOut = false;
    let findings: GateStepResult['findings'] = []; const notes: string[] = []; let backend: GateStepResult['environment']['backend'] = step.command ? 'none' : 'builtin';
    const deadline = new AbortController(); const combined = AbortSignal.any([signal, deadline.signal]); const timeout = setTimeout(() => { timedOut = true; deadline.abort(new Error('Verification step timed out')); }, step.timeoutMs);
    try {
      if (harnessOutcome !== 'completed' || fatal) { output = input.reason ?? (fatal ? 'Verification preparation failed; requirements were not executed' : 'Harness did not complete'); stderr = fatal ? String(fatal) : ''; observed = fatal && !input.reconciled && step.kind === 'scope' ? 'failed' : signal.aborted ? 'cancelled' : 'not_run'; }
      else if (signal.aborted) { observed = 'cancelled'; output = 'Verification cancelled before check execution'; }
      else if (['scope','test_integrity','secrets'].includes(step.kind)) {
        current = (await workspaceTree(owned!.identity.worktree)).entries; const result = guard(step); observed = result.status; output = result.output; findings = result.findings; notes.push(...result.limitations); exitCode = observed === 'passed' ? 0 : observed === 'failed' ? 1 : null;
      } else if (step.kind === 'dependencies' && !step.command) {
        current = (await workspaceTree(owned!.identity.worktree)).entries; const result = scanDependencies(current, step.advisories); observed = result.status; output = result.output; findings = result.findings; notes.push(...result.limitations); exitCode = observed === 'passed' ? 0 : observed === 'failed' ? 1 : null;
      } else if (step.kind === 'acceptance') {
        const result = await verifyAcceptance(owned!.identity.worktree, step.criteria!); observed = result.passed ? 'passed' : 'failed'; output = result.output; exitCode = result.passed ? 0 : 1;
      } else if (step.kind === 'syntax') {
        current = (await workspaceTree(owned!.identity.worktree)).entries;
        const changed = changedTreePaths(baseline, current).filter(path => /\.(?:[cm]?[jt]sx?|py|html?)$/i.test(path) && current.some(entry => entry.path === path && entry.kind === 'file'));
        const execute = trackedVerificationExecutor(repository, claim, step, owned!.identity.worktree, owned!.identity.root, join(directory, 'home'), options.runtime);
        const result = changed.length ? await syntaxCheck(owned!.identity.worktree, changed, directory, combined, execute) : { passed: true, unavailable: false, output: 'No changed source files require syntax parsing.' };
        observed = result.unavailable ? 'unavailable' : result.passed ? 'passed' : 'failed'; output = result.output; exitCode = result.passed ? 0 : result.unavailable ? null : 1; notes.push('Syntax parsing only; runtime behavior is established by separate configured tests.');
      } else if (step.command) {
        const executed = await runProfileCommand(repository, claim, step, owned!.identity.worktree, owned!.identity.root, join(directory, 'home'), combined, options.backend, options.runtime); const result = executed.result; backend = executed.backend;
        output = result.stdout ?? result.output; stderr = result.stderr ?? ''; exitCode = result.code; timedOut ||= result.timedOut;
        observed = result.code === null || result.code === 127 ? 'unavailable' : result.code === 0 && !timedOut ? 'passed' : 'failed';
        if (observed === 'passed' && step.testReport) { const evidence = verifyTestSummary(result.output, step.testReport.format, step.testReport.minimumTests); output += `\n${evidence.reason}\n`; if (!evidence.passed) observed = 'failed'; }
        if (result.truncated) { observed = 'unavailable'; notes.push('Output was truncated; complete execution/test evidence is unavailable.'); }
        if (backend === 'mock' && observed === 'passed') { observed = 'mock_verified'; notes.push('Mock-only verification: live integration was not tested.'); }
      } else if (step.kind === 'codex_security') {
        if (!step.enabled) { observed = 'unavailable'; output = 'Optional paid scanner is disabled; no Codex Security call was made.'; }
        else {
          const execute = trackedVerificationExecutor(repository, claim, step, owned!.identity.worktree, owned!.identity.root, join(directory, 'home'), options.runtime);
          const adapter = options.securityAdapter ?? new CodexSecurityAdapter(execute, step.maxCostUsd);
          const result = await adapter.scan({ repositoryPath: owned!.identity.worktree, outputDirectory: join(directory, `security-${step.id}`), signal: combined });
          findings = result.findings.map(finding => ({ id: finding.id, scanner: 'codex-security', severity: finding.severity, message: finding.title, path: finding.file, line: finding.line }));
          observed = result.status === 'passed' ? adapter instanceof CodexSecurityAdapter ? 'passed' : 'mock_verified' : result.status === 'findings' ? 'failed' : result.status === 'cancelled' ? 'cancelled' : 'unavailable';
          output = `Codex Security status: ${result.status}; reviewed coverage: ${JSON.stringify(result.coverage)}\n`; notes.push(...result.limitations); exitCode = observed === 'passed' ? 0 : observed === 'failed' ? 1 : null;
          if (observed === 'mock_verified') notes.push('Injected security result is mock coverage; live scanning is untested.');
        }
      }
    } catch (error) { stderr += String(error); observed = error instanceof CtxError && ['ENVIRONMENT_UNAVAILABLE','HARNESS_UNAVAILABLE'].includes(error.code) ? 'unavailable' : 'failed'; }
    finally { clearTimeout(timeout); }
    if (signal.aborted) observed = 'cancelled'; else if (timedOut || Date.now() - begin > step.timeoutMs) { observed = 'failed'; timedOut = true; stderr += '\nVerification step exceeded its timeout.'; }
    if (step.integration === 'mock' && observed === 'passed') { observed = 'mock_verified'; notes.push('Profile declares mock integration; live integration remains untested.'); }
    const result: GateStepResult = { id: step.id, kind: step.kind, required: step.required, status: observed, observedStatus: observed, startedAt: new Date(begin).toISOString(), endedAt: new Date().toISOString(), durationMs: Date.now() - begin, command: step.command ? [step.command.program, ...step.command.args] : undefined, exitCode, timedOut, findings, limitations: notes,
      stdoutArtifactId: await save('verification-stdout-log', output), stderrArtifactId: await save('verification-stderr-log', stderr),
      environment: { backend, node: process.versions.node, platform: process.platform, cwd: owned?.identity.worktree ?? '', timeoutMs: step.timeoutMs },
    }; applyWaiver(step, result); steps.push(result);
  }
  if (profile && owned && harnessOutcome === 'completed' && !fatal) {
    try {
      current = (await workspaceTree(owned.identity.worktree)).entries;
      for (const step of profile.steps.filter(step => ['scope','test_integrity','secrets'].includes(step.kind))) {
        const guardStarted = Date.now(); const checked = guard(step); const result = steps.find(result => result.id === step.id)!;
        result.findings = checked.findings; result.observedStatus = signal.aborted ? 'cancelled' : result.timedOut ? 'failed' : checked.status; result.status = result.observedStatus; delete result.waiverId;
        result.exitCode = checked.status === 'passed' ? 0 : checked.status === 'failed' ? 1 : null;
        result.startedAt = new Date(guardStarted).toISOString(); result.endedAt = new Date().toISOString(); result.durationMs = Date.now() - guardStarted; result.stdoutArtifactId = await save('verification-stdout-log', `Final guard after all configured commands:\n${checked.output}`); applyWaiver(step, result);
      }
      const changedByVerifier = changedTreePaths(verificationInput, current).filter(path => !profile.generatedPaths.some(pattern => pathMatches(path, pattern)));
      if (changedByVerifier.length) { const scope = steps.find(step => step.kind === 'scope')!; scope.status = scope.observedStatus = 'failed'; scope.findings.push(...changedByVerifier.map((path, index) => ({ id: `verifier-mutation-${index}`, scanner: 'ctx-source-stability', severity: 'high' as const, message: 'Verification modified deliverable source instead of only approved generated outputs', path }))); scope.exitCode = 1; }
      for (const result of steps.filter(result => result.waiverId)) if (repository.verification.applicableWaiver(claim, result.id)?.id !== result.waiverId) { result.status = result.observedStatus; delete result.waiverId; }
      const status = gateReportStatus(profile, steps, harnessOutcome);
      await privateGitScope(async () => {
        if (['passed','passed_with_waivers'].includes(status) && !signal.aborted) {
          await manager.assertOwned(owned!.id);
          const staged = await privateGit(['add','-A'], owned!.identity.worktree, signal); if (staged.code !== 0) throw new CtxError('CONFLICT', 'Cannot stage the verified deliverable');
          const committed = await privateGit(['-c','user.name=CTX','-c','user.email=ctx@localhost','-c','commit.gpgsign=false','commit','--allow-empty','-m', `Verified task ${claim.task.spec.id}`], owned!.identity.worktree, signal);
          if (committed.code !== 0) throw new CtxError('CONFLICT', 'Verified deliverable commit failed; task cannot complete');
        }
        owned = await manager.archive(owned!.id, actor, claim);
        const head = await privateGit(['rev-parse','HEAD'], owned.identity.worktree); if (head.code !== 0) throw new CtxError('CONFLICT', 'Cannot identify archived result commit'); resultSha = head.output.trim();
      });
    } catch (error) {
      limitations.push(`Final deliverable evidence unavailable: ${error instanceof CtxError ? error.message : 'archival failed'}`);
      const first = steps.find(step => step.kind === 'scope')!; first.observedStatus = first.status = 'failed'; first.findings.push({ id: 'deliverable-evidence', scanner: 'ctx-deliverable', severity: 'high', message: 'Final workspace/commit/evidence could not be retained safely' }); delete first.waiverId;
      first.stderrArtifactId = await save('verification-stderr-log', String(error));
    }
  }
  if (!profile) limitations.push('No owner-approved profile was frozen for this attempt; no project verification command was executed.');
  if (input.reason) limitations.push(input.reason);
  const report: GateReport = { schemaVersion: 1, id, taskId: claim.task.spec.id, attemptId: claim.attempt.id, taskSpecHash: frozen.taskSpecHash, profileId: claim.task.spec.verificationProfile, profileHash: frozen.profileHash, workspaceId: owned?.id, workspaceHash: owned?.archiveTreeHash, baseSha: owned?.identity.baseSha, resultSha,
    reconciled: input.reconciled || undefined,
    harnessArtifactId: repository.artifacts(claim.task.spec.id).find(artifact => artifact.attemptId === claim.attempt.id && artifact.kind === 'harness-result')?.id,
    status: gateReportStatus(profile, steps, harnessOutcome), steps, harnessOutcome, limitations, startedAt, endedAt: new Date().toISOString(), artifactIds: [...new Set([...repository.artifacts(claim.task.spec.id).filter(artifact => artifact.attemptId === claim.attempt.id).map(artifact => artifact.id), ...published])],
  };
  const json = JSON.stringify(report, null, 2) + '\n'; const markdown = renderVerificationReport(report);
  for (const [name, content] of [['report.json', json], ['REPORT.md', markdown]]) { const file = await open(join(directory, name), 'wx', 0o600); try { await file.writeFile(content); await file.sync(); } finally { await file.close(); } }
  await syncPath(directory);
  const jsonArtifact = await save('verification-report-json', json); const markdownArtifact = await save('verification-report-markdown', markdown);
  return repository.verification.recordReport(claim, jsonArtifact, markdownArtifact, actor);
}

/** Software-only report repair. Never executes project checks or infers a historical pass. */
export async function reconcileVerificationReports(repository: TaskRepository, actor: CommandActor): Promise<number> {
  repository.queue.reconcile(actor); let recovered = 0;
  for (const task of repository.listTasks()) {
    const attempts = repository.queue.attempts(task.spec.id); if (attempts.some(attempt => ['leased','running','verifying'].includes(attempt.state))) continue;
    for (const attempt of attempts.filter(attempt => attempt.harnessId !== 'fixture' && !['leased','running','verifying'].includes(attempt.state))) {
      if (repository.verification.reports(task.spec.id).some(report => report.attemptId === attempt.id && report.reportArtifactId)) continue;
      const claim: LeaseClaim = { task, attempt, ownerId: 'report-reconciliation', fencingToken: attempt.fencingToken, expiresAt: new Date().toISOString() };
      try {
        repository.verification.assertHistoricalQuiescence(claim, actor);
        await verifyEngineeringAttempt(repository, claim, actor, new AbortController().signal, {}, { reconciled: true, harnessOutcome: attempt.state === 'completed' ? 'completed' : attempt.state === 'failed' ? 'failed' : 'interrupted', reason: 'Recovered report from retained partial evidence; no check or model execution was replayed and no completion is inferred' }); recovered++;
      } catch (error) { if (!(error instanceof CtxError && error.code === 'CONFLICT')) throw error; }
    }
  }
  return recovered;
}
