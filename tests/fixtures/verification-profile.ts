import type { VerificationProfile } from '../../packages/shared/src/verification-profile.js';
export function profileFixture(): VerificationProfile {
  return { schemaVersion: 1, id: 'node-api', purpose: 'filesystem', backend: 'none', generatedPaths: [], protectedPaths: [], steps: [
    { id: 'scope', kind: 'scope', required: true, waivable: false, timeoutMs: 1000, integration: 'live' },
    { id: 'integrity', kind: 'test_integrity', required: true, waivable: false, timeoutMs: 1000, integration: 'live' },
    { id: 'secrets', kind: 'secrets', required: true, waivable: false, timeoutMs: 1000, integration: 'live' },
    { id: 'scanner', kind: 'codex_security', required: true, waivable: true, timeoutMs: 1000, integration: 'live', enabled: false },
  ] };
}
