export const artifactPolicy = Object.freeze({ maxArtifactBytes: 16 * 1024 * 1024, maxTaskBytes: 256 * 1024 * 1024,
  maxDatabaseBytes: 512 * 1024 * 1024, maxBackupBytes: 1024 * 1024 * 1024, maxBackupFiles: 10_000,
  logRetentionDays: 30, orphanRetentionHours: 24, preserveEvidence: true, redactText: true });
export interface ArtifactRecord {
  id: string; taskId: string; attemptId?: string; kind: string; location: string;
  sha256: string; bytes: number; createdAt: string;
}
export interface ArtifactManifest extends ArtifactRecord {
  schemaVersion: 1; format: 'text' | 'binary'; redacted: boolean;
  retention: { class: 'log' | 'evidence'; days: number | null };
}
