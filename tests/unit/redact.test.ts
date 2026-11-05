import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact } from '../../packages/shared/src/redact.js';
test('redacts known credential environment values and OpenAI key patterns', () => {
  const previous = process.env.HARNESS_TEST_API_KEY;
  process.env.HARNESS_TEST_API_KEY = 'fixture-sensitive-value';
  try {
    assert.equal(redact('key=fixture-sensitive-value sk-abcdefghijklmnopqr'), 'key=[REDACTED] [REDACTED]');
    assert.equal(redact('ordinary test output'), 'ordinary test output');
  } finally { if (previous === undefined) delete process.env.HARNESS_TEST_API_KEY; else process.env.HARNESS_TEST_API_KEY = previous; }
});
