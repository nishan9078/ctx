import { test } from 'node:test';
import assert from 'node:assert/strict';
import { greet } from './index.js';
test('greets by name', () => assert.equal(greet('Ada'), 'Hello, Ada!'));
