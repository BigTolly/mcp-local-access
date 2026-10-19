// Bridge + Router against a Python mock of server.py's WebSocket bridge.
// Needs `python` with the `websockets` package (already required by server.py).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { Bridge } from '../src/background/bridge.js';
import { Router, isParallelSafe } from '../src/background/router.js';

const PORT = 19000 + Math.floor(Math.random() * 900);
const script = fileURLToPath(new URL('./mock_server.py', import.meta.url));

function startMock() {
  const proc = spawn(process.env.PYTHON || 'python', ['-u', script, String(PORT)], { stdio: ['pipe', 'pipe', 'inherit'] });
  const events = [];
  const waiters = [];
  createInterface({ input: proc.stdout }).on('line', (line) => {
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    events.push(ev);
    for (const w of [...waiters]) {
      if (w.match(ev)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(ev);
      }
    }
  });
  const waitFor = (match, ms = 5000) =>
    new Promise((resolve, reject) => {
      const found = events.find((e) => match(e) && !e.consumed);
      if (found) {
        found.consumed = true;
        return resolve(found);
      }
      const w = { match, resolve: (e) => { e.consumed = true; clearTimeout(t); resolve(e); } };
      const t = setTimeout(() => {
        waiters.splice(waiters.indexOf(w), 1);
        reject(new Error('timeout waiting for mock event'));
      }, ms);
      waiters.push(w);
    });
  const send = (obj) => proc.stdin.write(JSON.stringify(obj) + '\n');
  return { proc, events, waitFor, send };
}

const response = (id) => (e) => e.event === 'message' && e.data?.type === 'messageResponse' && e.data.payload?.requestId === id;

test('bridge talks the server.py wire format and survives reconnects', async () => {
  const mock = startMock();
  try {
    await mock.waitFor((e) => e.event === 'listening', 10000);
    const seenPayloads = [];
    const router = new Router({
      echo: (p) => p,
      getUrl: (p) => {
        seenPayloads.push(p);
        return 'https://example.test/';
      },
      nothing: () => undefined,
      fail: () => {
        throw new Error('No tab is connected');
      },
    });
    const statuses = [];
    const bridge = new Bridge({
      url: () => `ws://127.0.0.1:${PORT}`,
      onRequest: (m) => router.handle(m),
      onStatus: (s) => statuses.push(s),
      keepaliveMs: 200,
    });
    bridge.start();
    await mock.waitFor((e) => e.event === 'connected');

    mock.send({ send: { id: 'r1', type: 'echo', payload: { x: 1, s: 'привет 🚀' } } });
    const r1 = await mock.waitFor(response('r1'));
    assert.deepEqual(r1.data.payload.result, { x: 1, s: 'привет 🚀' });

    mock.send({ send: { id: 'r2', type: 'getUrl' } }); // no payload, like server.py
    const r2 = await mock.waitFor(response('r2'));
    assert.equal(r2.data.payload.result, 'https://example.test/');
    assert.deepEqual(seenPayloads[0], {});

    mock.send({ send: { id: 'r3', type: 'nothing', payload: {} } });
    const r3 = await mock.waitFor(response('r3'));
    assert.equal(r3.data.payload.result, null);
    assert.ok('result' in r3.data.payload);

    mock.send({ send: { id: 'r4', type: 'fail', payload: {} } });
    const r4 = await mock.waitFor(response('r4'));
    assert.equal(r4.data.payload.error, 'No tab is connected');

    mock.send({ send: { id: 'r5', type: 'nope', payload: {} } });
    const r5 = await mock.waitFor(response('r5'));
    assert.equal(r5.data.payload.error, 'Unknown command: nope');

    await mock.waitFor((e) => e.event === 'message' && e.data?.type === 'keepalive', 3000);

    // server drops the link -> the extension reconnects by itself
    mock.send({ close: true });
    await mock.waitFor((e) => e.event === 'disconnected');
    await mock.waitFor((e) => e.event === 'connected', 5000);
    mock.send({ send: { id: 'r6', type: 'echo', payload: { again: true } } });
    const r6 = await mock.waitFor(response('r6'));
    assert.deepEqual(r6.data.payload.result, { again: true });
    assert.ok(bridge.reconnects >= 1);

    // user disconnect -> no reconnect
    bridge.stop();
    await mock.waitFor((e) => e.event === 'disconnected');
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(mock.events.filter((e) => e.event === 'connected').length, 2);
    assert.equal(bridge.status, 'idle');
    assert.ok(statuses.includes('open') && statuses.includes('closed'));
  } finally {
    mock.send({ quit: true });
    mock.proc.kill();
  }
});

test('router serializes actions but lets reads through', async () => {
  const order = [];
  const router = new Router({
    browser_click: async () => {
      order.push('click:start');
      await new Promise((r) => setTimeout(r, 150));
      order.push('click:end');
    },
    browser_type: async () => {
      order.push('type');
    },
    browser_diagnostics: async () => {
      order.push('diag');
      return { ok: true };
    },
  });
  await Promise.all([
    router.handle({ id: 1, type: 'browser_click', payload: {} }),
    router.handle({ id: 2, type: 'browser_type', payload: {} }),
    router.handle({ id: 3, type: 'browser_diagnostics', payload: {} }),
  ]);
  // the read ran while the click was in flight; the second action waited for the first
  assert.ok(order.indexOf('diag') < order.indexOf('click:end'));
  assert.ok(order.indexOf('click:end') < order.indexOf('type'));
  assert.equal(router.recent(10).length, 3);
});

test('cdp_events subscribe and network start wait for a running action', async () => {
  assert.equal(isParallelSafe('browser_cdp_events', { action: 'read' }), true);
  assert.equal(isParallelSafe('browser_cdp_events', { action: 'subscribe' }), false);
  assert.equal(isParallelSafe('browser_cdp_events', { action: 'unsubscribe' }), false);
  assert.equal(isParallelSafe('browser_network', { action: 'list' }), true);
  assert.equal(isParallelSafe('browser_network', { action: 'start' }), false);
  assert.equal(isParallelSafe('browser_click', {}), false);
  assert.equal(isParallelSafe('getUrl', undefined), true);
  const order = [];
  const router = new Router({
    browser_navigate: async () => {
      order.push('nav:start');
      await new Promise((r) => setTimeout(r, 100));
      order.push('nav:end');
    },
    browser_cdp_events: async ({ action }) => {
      order.push(action);
      return {};
    },
  });
  await Promise.all([
    router.handle({ id: 1, type: 'browser_navigate', payload: {} }),
    router.handle({ id: 2, type: 'browser_cdp_events', payload: { action: 'subscribe', domain: 'DOM' } }),
    router.handle({ id: 3, type: 'browser_cdp_events', payload: { action: 'read' } }),
  ]);
  assert.ok(order.indexOf('read') < order.indexOf('nav:end'), order.join());
  assert.ok(order.indexOf('nav:end') < order.indexOf('subscribe'), order.join());
});
