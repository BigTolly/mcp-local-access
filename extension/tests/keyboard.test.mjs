import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCombo, pressKey, resolveKey } from '../src/shared/keyboard.js';

function recorder({ failOn } = {}) {
  const events = [];
  const send = async (method, params) => {
    assert.equal(method, 'Input.dispatchKeyEvent');
    events.push(params);
    if (failOn && failOn(params)) throw new Error('boom');
  };
  return { events, send };
}

test('single keys: Enter has text, ArrowLeft has none, letters keep case', async () => {
  const r = recorder();
  await pressKey(r.send, 'Enter');
  assert.deepEqual(r.events.map((e) => [e.type, e.key, e.text]), [['keyDown', 'Enter', '\r'], ['keyUp', 'Enter', undefined]]);
  assert.equal(resolveKey('ArrowLeft').keyCode, 37);
  assert.equal(resolveKey('a').code, 'KeyA');
  assert.equal(resolveKey('ё').text, 'ё');
  assert.equal(resolveKey('🚀').text, '🚀');
});

test('combo Control+Shift+a: modifiers down in order, released in reverse, no text', async () => {
  const r = recorder();
  await pressKey(r.send, 'Control+Shift+a');
  assert.deepEqual(
    r.events.map((e) => [e.type, e.key, e.modifiers, e.text]),
    [
      ['rawKeyDown', 'Control', 2, undefined],
      ['rawKeyDown', 'Shift', 10, undefined],
      ['rawKeyDown', 'A', 10, undefined],
      ['keyUp', 'A', 10, undefined],
      ['keyUp', 'Shift', 2, undefined],
      ['keyUp', 'Control', 0, undefined],
    ],
  );
});

test('Shift+a types an upper-case A', async () => {
  const r = recorder();
  await pressKey(r.send, 'Shift+a');
  const down = r.events.find((e) => e.type === 'keyDown');
  assert.equal(down.text, 'A');
});

test('aliases and the plus key', () => {
  assert.deepEqual(parseCombo('Ctrl+Esc').modifiers.map((m) => m.key), ['Control']);
  assert.equal(parseCombo('Ctrl+Esc').key.key, 'Escape');
  assert.equal(parseCombo('Control++').key.key, '+');
  assert.equal(parseCombo('+').key.key, '+');
  assert.equal(parseCombo('F5').key.keyCode, 116);
});

test('unknown keys and modifiers are rejected before anything is pressed', async () => {
  const r = recorder();
  await assert.rejects(pressKey(r.send, 'MCP_NONEXISTENT_KEY'), /Unknown key/);
  await assert.rejects(pressKey(r.send, 'Foo+a'), /Unknown modifier/);
  await assert.rejects(pressKey(r.send, 'a+b'), /Unknown modifier/);
  assert.equal(r.events.length, 0);
});

test('a failure in the middle still releases every modifier (donor bug)', async () => {
  const r = recorder({ failOn: (p) => p.type === 'rawKeyDown' && p.key === 'A' });
  await assert.rejects(pressKey(r.send, 'Control+Shift+a'), /boom/);
  const ups = r.events.filter((e) => e.type === 'keyUp').map((e) => e.key);
  assert.ok(ups.includes('Shift') && ups.includes('Control'), `released: ${ups}`);
  const last = r.events[r.events.length - 1];
  assert.equal(last.key, 'Control');
  assert.equal(last.modifiers, 0);
});

test('failure while pressing a modifier releases the ones already down', async () => {
  const r = recorder({ failOn: (p) => p.type === 'rawKeyDown' && p.key === 'Shift' });
  await assert.rejects(pressKey(r.send, 'Control+Shift+a'), /boom/);
  const ups = r.events.filter((e) => e.type === 'keyUp').map((e) => e.key);
  assert.deepEqual(ups, ['Control']);
});
