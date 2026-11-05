import type { ProcessResult } from './process-manager.js';
import type { DockerAccessDiagnostic } from './docker-diagnostics.js';
export interface MockRoute { method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; path: string; status: number; body: unknown }
export interface MockSpec { urlVariable: string; keyVariable?: string; routes: MockRoute[] }
export interface EnvironmentOptions {
  mode?: 'docker' | 'host'; image?: string; allowImagePull?: boolean; allowDependencyInstall?: boolean;
  maxRecoveryAttempts?: number; services?: { postgres?: boolean; mock?: MockSpec };
}
export interface EnvironmentConfig {
  mode: 'docker' | 'host'; image: string; allowImagePull: boolean; allowDependencyInstall: boolean;
  maxRecoveryAttempts: number; services: { postgres?: boolean; mock?: MockSpec }; envKeys: string[];
}
export type FailureKind = 'postgres-unavailable' | 'mock-unavailable' | 'missing-env' | 'missing-dependency' | 'missing-api-key' | 'port-in-use' | 'browser-unavailable' | 'unknown';
export interface ManagedResource { name: string; kind: 'network' | 'container'; status: 'intent' | 'ready' | 'removed' | 'error'; purpose: string }
export interface RecoveryAttempt { id: number; kind: FailureKind; status: 'running' | 'passed' | 'failed'; reason: string; artifact: string }
export interface EnvironmentState {
  config: EnvironmentConfig; ready: boolean; network: string; variables: Record<string, string>;
  resources: ManagedResource[]; recoveries: RecoveryAttempt[]; remainingRecoveryAttempts: number;
  verificationRound: number; activeRecovery?: number; dependencies: { name: string; kind: 'real' | 'mock'; verified: boolean }[];
  limitations: string[]; cleanupErrors: string[];
  dockerDiagnostic?: DockerAccessDiagnostic; dockerDiagnosticArtifact?: string;
}
export interface CommandRunner { run(command: string, signal?: AbortSignal, timeoutMs?: number): Promise<ProcessResult> }
export interface DockerDriver { readonly kind: 'live' | 'simulated'; command(args: string[], signal?: AbortSignal, timeoutMs?: number): Promise<ProcessResult> }
export class EnvironmentUnavailable extends Error { override name = 'EnvironmentUnavailable'; }
