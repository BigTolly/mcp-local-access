import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConsoleStore, formatConsoleArgs, formatRemoteObject } from '../src/shared/console-store.js';

const str = (value) => ({ type: 'string', value });

test('formatting: printf, objects with preview, arrays, errors, special numbers', () => {
  assert.equal(formatConsoleArgs([str('%s has %d items'), str('cart'), { type: 'number', value: 3.7 }]), 'cart has 3 items');
  assert.equal(formatConsoleArgs([str('%cstyled'), str('color:red')]), 'styled');
  assert.equal(formatConsoleArgs([str('a'), { type: 'number', value: 1 }, { type: 'boolean', value: false }]), 'a 1 false');
  assert.equal(
    formatRemoteObject({ type: 'object', preview: { type: 'object', description: 'Object', properties: [{ name: 'a', type: 'number', value: '1' }, { name: 'b', type: 'string', value: 'x' }] } }),
    '{a: 1, b: "x"}',
  );
  assert.equal(formatRemoteObject({ type: 'object', subtype: 'array', preview: { type: 'object', subtype: 'array', properties: [{ name: '0', type: 'number', value: '1' }], overflow: true } }), '[1, …]');
  assert.equal(formatRemoteObject({ type: 'object', subtype: 'error', description: 'Error: boom\n    at x' }), 'Error: boom\n    at x');
  assert.equal(formatRemoteObject({ type: 'number', unserializableValue: 'NaN' }), 'NaN');
  assert.equal(formatRemoteObject({ type: 'object', subtype: 'null', value: null }), 'null');
  assert.equal(formatRemoteObject({ type: 'undefined' }), 'undefined');
});

test('functions inside previews render as ƒ, not as an empty slot', () => {
  // Shape copied from Chrome 155 for console.log([()=>1, function named(){}], {f(){}}).
  const arr = { type: 'object', subtype: 'array', preview: { type: 'object', subtype: 'array', description: 'Array(2)', overflow: false, properties: [{ name: '0', type: 'function', value: '' }, { name: '1', type: 'function', value: '' }] } };
  const obj = { type: 'object', preview: { type: 'object', description: 'Object', overflow: false, properties: [{ name: 'f', type: 'function', value: '' }] } };
  assert.equal(formatConsoleArgs([str('FN_TEST'), arr, obj]), 'FN_TEST [ƒ, ƒ] {f: ƒ}');
  assert.equal(formatRemoteObject({ type: 'object', preview: { type: 'object', description: 'Object', properties: [{ name: 'x', type: 'accessor' }] } }), '{x: (...)}');
});

test('acceptance markers: early error, exception, after-load log/warn/error', () => {
  const s = new ConsoleStore(100);
  s.onConsoleApi({ type: 'error', args: [str('MCP_EARLY_ERROR')], timestamp: 1000, stackTrace: { callFrames: [{ functionName: '', url: 'http://t/acceptance.html', lineNumber: 6, columnNumber: 8 }] } });
  s.onException({ timestamp: 1001, exceptionDetails: { exceptionId: 1, text: 'Uncaught', lineNumber: 10, columnNumber: 14, url: 'http://t/acceptance.html', exception: { type: 'object', subtype: 'error', description: 'Error: MCP_EARLY_EXCEPTION\n    at http://t/acceptance.html:11:15' } } });
  s.mark('navigation', 'Navigated to http://t/acceptance.html');
  s.onConsoleApi({ type: 'log', args: [str('MCP_AFTER_LOG')], timestamp: 2000 });
  s.onConsoleApi({ type: 'warning', args: [str('MCP_AFTER_WARN')], timestamp: 2001 });
  s.onConsoleApi({ type: 'error', args: [str('MCP_AFTER_ERROR')], timestamp: 2002 });
  s.onLogEntry({ entry: { source: 'network', level: 'error', text: 'Failed to load resource: 404', timestamp: 2003, url: 'http://t/missing' } });
  const all = s.query({ limit: 100, level: 'all' });
  assert.equal(all.returned, 7);
  assert.deepEqual(all.logs.map((e) => e.level), ['error', 'exception', 'navigation', 'log', 'warning', 'error', 'error']);
  const exc = all.logs[1];
  assert.equal(exc.text, 'Uncaught Error: MCP_EARLY_EXCEPTION');
  assert.equal(exc.line, 11);
  assert.match(exc.stack, /acceptance\.html:11:15/);
  assert.equal(all.logs[0].line, 7);
  assert.match(all.logs[0].stack, /acceptance\.html:7:9/);
  assert.equal(all.logs[6].source, 'browser:network');
  const errors = s.query({ limit: 100, level: 'error' });
  assert.equal(errors.matched, 3);
  assert.equal(s.query({ limit: 2, level: 'all' }).logs[1].text, 'Failed to load resource: 404');
});

test('history replay after re-enable does not duplicate entries', () => {
  const s = new ConsoleStore(100);
  const msg = { type: 'log', args: [str('hello')], timestamp: 42 };
  s.onConsoleApi(msg);
  s.onConsoleApi(msg); // replayed by Runtime.enable
  assert.equal(s.query({}).returned, 1);
  assert.equal(s.stats().duplicatesSkipped, 1);
  // explicit clear keeps dedupe keys: a replay must not resurrect cleared logs
  s.clear();
  s.onConsoleApi(msg);
  assert.equal(s.query({}).returned, 0);
  // a new tab forgets everything
  s.reset();
  s.onConsoleApi(msg);
  assert.equal(s.query({}).returned, 1);
});

test('replay without previews is still a duplicate', () => {
  const s = new ConsoleStore(100);
  const frame = { callFrames: [{ functionName: '', url: '', lineNumber: 0, columnNumber: 8 }] };
  // Live event: objects carry previews.
  s.onConsoleApi({
    type: 'log',
    timestamp: 1760848077491.25,
    stackTrace: frame,
    args: [
      str('FN_TEST'),
      { type: 'object', subtype: 'array', description: 'Array(2)', preview: { type: 'object', subtype: 'array', description: 'Array(2)', properties: [{ name: '0', type: 'function', value: '' }, { name: '1', type: 'function', value: '' }] } },
      { type: 'object', className: 'Object', description: 'Object', preview: { type: 'object', description: 'Object', properties: [{ name: 'f', type: 'function', value: '' }] } },
      { type: 'function', className: 'Function', description: '()=>2' },
    ],
  });
  // Replay after re-attach: same timestamp, no previews.
  s.onConsoleApi({
    type: 'log',
    timestamp: 1760848077491.25,
    args: [
      str('FN_TEST'),
      { type: 'object', subtype: 'array', description: 'Array(2)' },
      { type: 'object', className: 'Object', description: 'Object' },
      { type: 'function', className: 'Function', description: '()=>2' },
    ],
  });
  const q = s.query({});
  assert.equal(q.returned, 1);
  assert.equal(q.logs[0].text, 'FN_TEST [ƒ, ƒ] {f: ƒ} ()=>2');
  assert.equal(s.stats().duplicatesSkipped, 1);
  // Different primitive arguments at the same instant are NOT merged.
  s.onConsoleApi({ type: 'log', timestamp: 7, args: [str('a')] });
  s.onConsoleApi({ type: 'log', timestamp: 7, args: [str('b')] });
  assert.equal(s.query({}).returned, 3);
});

test('ring buffer reports dropped messages', () => {
  const s = new ConsoleStore(3);
  for (let i = 0; i < 5; i++) s.onConsoleApi({ type: 'log', args: [str(`m${i}`)], timestamp: i });
  const q = s.query({ limit: 10 });
  assert.deepEqual(q.logs.map((e) => e.text), ['m2', 'm3', 'm4']);
  assert.equal(q.dropped, 2);
  assert.equal(q.total, 5);
});
