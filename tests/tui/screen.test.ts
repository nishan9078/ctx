import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestRenderer, KeyCodes } from '@opentui/core/testing';
import { ScreenTerminalSurface } from '../../apps/cli/src/terminal-screen.js';
const options = { kittyKeyboard: true, width: 110, height: 32, exitOnCtrlC: false, exitSignals: [] };

test('persistent header, multiline composer, mode switch and activity expansion share state', async () => {
  const setup = await createTestRenderer(options); const view = new ScreenTerminalSurface(setup.renderer);
  try {
    view.update({ repository: '/work/project', branch: 'feature/tui', execution: 'docker', busy: true, progress: 'Running tests', security: 'not run', plan: '✓ Plan\n› Code', checks: 'build: passed\ntest: running' });
    view.write('Changes are ready for review.');
    view.activity({ id: 'tool-1', title: 'npm test', body: '17 tests passed', kind: 'tool' });
    await setup.renderOnce(); let frame = setup.captureCharFrame();
    assert.match(frame, /CTX.*Minimal/); assert.match(frame, /\/work\/project/); assert.match(frame, /feature\/tui/); assert.match(frame, /Running tests/);
    assert.doesNotMatch(frame, /npm test/); assert.doesNotMatch(frame, /TASK PLAN/);
    await setup.mockInput.typeText('First line'); setup.mockInput.pressKey('j', { ctrl: true }); await setup.mockInput.typeText('Second line');
    setup.mockInput.pressTab(); await setup.renderOnce(); frame = setup.captureCharFrame();
    assert.equal(view.model.mode, 'detailed'); assert.match(frame, /TASK PLAN/); assert.match(frame, /npm test/);
    assert.match(frame, /First line/); assert.match(frame, /Second line/);
    setup.mockInput.pressKey('o', { ctrl: true }); await setup.renderOnce(); assert.match(setup.captureCharFrame(), /Activity inspector/);
    setup.mockInput.pressEnter(); await setup.renderOnce(); assert.match(setup.captureCharFrame(), /17 tests passed/);
    setup.mockInput.pressEscape();
    let submitted = ''; view.on('line', value => { submitted = value; }); setup.mockInput.pressEnter();
    assert.equal(submitted, 'First line\nSecond line');
    setup.mockInput.pressTab(); await setup.renderOnce();
    assert.equal(view.model.mode, 'minimal'); assert.match(setup.captureCharFrame(), /First line/);
    assert.equal(view.model.entries.filter(entry => entry.id === 'tool-1').length, 1);
    let interrupts = 0; view.on('SIGINT', () => { interrupts++; }); setup.mockInput.pressCtrlC(); assert.equal(interrupts, 1);
    let closed = 0; view.on('close', () => { closed++; }); view.close(); view.close(); assert.equal(closed, 1);
  } finally { await view.destroy(); await view.destroy(); }
});

test('searchable palette and help overlay manage focus without losing the composer draft', async () => {
  const setup = await createTestRenderer(options); const view = new ScreenTerminalSurface(setup.renderer);
  try {
    await setup.mockInput.typeText('draft'); setup.mockInput.pressKey('p', { ctrl: true });
    await setup.mockInput.typeText('tasks'); await setup.renderOnce(); assert.match(setup.captureCharFrame(), /Command palette/);
    let selected = ''; view.on('line', value => { selected = value; }); setup.mockInput.pressEnter(); assert.equal(selected, '/tasks');
    setup.mockInput.pressKey(KeyCodes.F1); await setup.renderOnce(); assert.match(setup.captureCharFrame(), /Help · Esc close/);
    setup.mockInput.pressEscape(); await setup.renderOnce(); assert.match(setup.captureCharFrame(), /draft/);
    setup.mockInput.pressEnter(); assert.equal(selected, 'draft');
  } finally { await view.destroy(); }
});

test('transcript sanitizes control text and both modes resize without losing history', async () => {
  const setup = await createTestRenderer(options); const view = new ScreenTerminalSurface(setup.renderer);
  try {
    for (let index = 0; index < 80; index++) view.write(`Message ${index}`);
    view.write('\x1b[31mLatest safe message\x1b[0m\x07'); await setup.renderOnce();
    assert.match(setup.captureCharFrame(), /Latest safe message/);
    setup.mockInput.pressKey('\x1b[5~'); await setup.renderOnce(); assert.doesNotMatch(setup.captureCharFrame(), /Latest safe message/);
    setup.mockInput.pressKey('\x1b[6~'); await setup.renderOnce(); assert.match(setup.captureCharFrame(), /Latest safe message/);
    setup.resize(48, 15); await setup.renderOnce(); assert.match(setup.captureCharFrame(), /Latest safe message/); assert.match(setup.captureCharFrame(), /Message CTX/);
    setup.mockInput.pressTab(); await setup.renderOnce(); assert.match(setup.captureCharFrame(), /Detailed/); assert.doesNotMatch(setup.captureCharFrame(), /TASK PLAN/);
    assert.equal(view.model.entries.length, 81);
  } finally { await view.destroy(); }
});

test('sign-in handoff restores focus when the external command fails', async () => {
  const setup = await createTestRenderer(options); const view = new ScreenTerminalSurface(setup.renderer);
  try {
    await setup.renderer.setupTerminal();
    await assert.rejects(view.handoff(async () => { throw new Error('Sign-in cancelled'); }), /Sign-in cancelled/);
    view.write('Back in CTX'); await setup.renderOnce(); assert.match(setup.captureCharFrame(), /Back in CTX/);
    let command = ''; view.on('line', value => { command = value; }); await setup.mockInput.typeText('/tasks'); setup.mockInput.pressEnter(); assert.equal(command, '/tasks');
  } finally { await view.destroy(); }
});
