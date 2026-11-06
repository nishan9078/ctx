# Phase 04 foundation repair evidence

Starting point: `02502b3` on `roadmap/p04-codex-worker`. Existing OpenCode commits preserved.

Fixed ESM SDK version resolution, warning-tolerant CLI version parsing, historical schema 4 backup compatibility, verification-step insertion arity, and conflicting session replacement. Added deterministic persistence/probe regression tests.

Checks (development Node 22.22.1):
- `pnpm typecheck`: exit 0.
- `pnpm check:boundaries`: exit 0, no cycles.
- `pnpm build && node --test --test-reporter=tap dist/tests/unit/codex-probe.test.js dist/tests/integration/codex-persistence.test.js`: exit 0; 7 passed.
- `pnpm test` in authorized execution context: exit 0; 245 total, 240 passed, 5 optional live skips.

The restricted sandbox suppresses output from a minimal Node child process while returning exit 0. The same child prints the expected output in the authorized context. Full-suite failures from empty subprocess output in the sandbox are environment limitations; tests were not weakened.

Live Codex execution and full Phase 04 acceptance remain pending.
