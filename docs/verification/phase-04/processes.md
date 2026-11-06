# Owned Codex subprocess verification

`pnpm build`: exit 0. `pnpm typecheck`: exit 0.

`node --test --test-reporter=tap dist/tests/integration/codex-process.test.js dist/tests/unit/adapter.test.js`: exit 0; 15 passed. See `processes.log`.

Deterministic Linux fixtures cover pre-cancellation, acknowledged event delivery, cancellation of resistant descendants, leader exit before descendants, abnormal exit, persistence-sink failure, and supervisor SIGKILL with orphan-group cleanup. The orphan test exercises the installed public SDK with a controlled executable; it is not a live provider call. Existing legacy adapter cases remain passing, and unknown additive SDK event types can now pass to the normalizer.

Containment is Linux/POSIX process-group ownership, not an adversarial resource sandbox. Processes deliberately escaping their group and full resource/Git ownership hardening remain Phase 05 work. No cross-platform guarantee is claimed.
