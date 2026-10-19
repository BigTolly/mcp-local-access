import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CdpSession } from '../src/background/cdp.js';

/** Fake chrome.debugger with scriptable failures. */
function fakeDebugger({ alreadyAttached = false, foreignOwner = false } = {}) {
  const calls = [];
  let attached = alreadyAttached;
  return {
    calls,
    get attached() {
      return attached;
    },
    forceDetach() {
      attached = false;
    },
    async attach({ tabId }, version) {
      calls.push(['attach', tabId, version]);
      if (attached) throw new Error(`Another debugger is already attached to the tab with id: ${tabId}.`);
      attached = true;
    },
    async detach() {
      calls.push(['detach']);
      attached = false;
    },
    async sendCommand(_target, method, params) {
      calls.push([method, params]);
      if (foreignOwner) throw new Error('{"code":-32000,"message":"Debugger is not attached to the tab"}');
      if (!attached) throw new Error('Debugger is not attached to the tab with id: 7.');
      if (method === 'Broken.enable') throw new Error('{"code":-32601,"message":"\'Broken.enable\' wasn\'t found"}');
      return { ok: method };
    },
  };
}

const methods = (api) => api.calls.map((c) => c[0]);

test('attach enables Page, Runtime and Log once', async () => {
  const api = fakeDebugger();
  const cdp = new CdpSession({ api });
  cdp.setTab(7);
  await cdp.ensure();
  await cdp.ensure();
  assert.deepEqual(methods(api), ['attach', 'Page.enable', 'Runtime.enable', 'Log.enable']);
  assert.deepEqual(cdp.status().domains.sort(), ['Log', 'Page', 'Runtime']);
  assert.equal(cdp.generation, 1);
});

test('detach is recorded and the next command re-attaches and re-enables', async () => {
  const api = fakeDebugger();
  const cdp = new CdpSession({ api });
  cdp.setTab(7);
  await cdp.want('Network');
  const reasons = [];
  cdp.onDetach((r) => reasons.push(r));
  api.forceDetach();
  cdp.handleDetach({ tabId: 7 }, 'target_closed');
  assert.equal(cdp.attached, false);
  assert.equal(cdp.status().lastDetach.reason, 'target_closed');
  assert.deepEqual(reasons, ['target_closed']);
  api.calls.length = 0;
  const result = await cdp.send('DOM.getDocument', {});
  assert.deepEqual(result, { ok: 'DOM.getDocument' });
  assert.deepEqual(methods(api), ['attach', 'Page.enable', 'Runtime.enable', 'Log.enable', 'Network.enable', 'DOM.getDocument']);
  assert.equal(cdp.generation, 2);
  assert.equal(cdp.reattachCount, 1);
});

test('Chrome bar closed (canceled_by_user): paused, nothing re-attaches until the next command', async () => {
  const api = fakeDebugger();
  const cdp = new CdpSession({ api });
  cdp.setTab(7);
  await cdp.want('Network');
  api.forceDetach();
  cdp.handleDetach({ tabId: 7 }, 'canceled_by_user');
  assert.equal(cdp.attached, false);
  assert.ok(cdp.status().pausedByUser, 'pause recorded');
  assert.equal(cdp.tabId, 7, 'the tab stays selected');
  api.calls.length = 0;
  await Promise.resolve();
  assert.deepEqual(methods(api), [], 'no automatic attach: the bar must not pop back by itself');
  await cdp.send('DOM.getDocument', {});
  assert.deepEqual(methods(api), ['attach', 'Page.enable', 'Runtime.enable', 'Log.enable', 'Network.enable', 'DOM.getDocument']);
  assert.equal(cdp.status().pausedByUser, null, 'pause cleared by the re-attach');
  cdp.handleDetach({ tabId: 7 }, 'canceled_by_user');
  cdp.setTab(8);
  assert.equal(cdp.pausedByUser, null, 'a new tab starts unpaused');
});

test('attach to a protected page explains how to get out', async () => {
  const api = fakeDebugger();
  api.attach = async () => {
    throw new Error('Cannot access a chrome:// URL');
  };
  const cdp = new CdpSession({ api });
  cdp.setTab(7);
  await assert.rejects(cdp.ensure(), /Cannot access a chrome:\/\/ URL\. The tab shows a page Chrome protects .*browser_navigate/);
});

test('silent detach (no event) is healed by one retry', async () => {
  const api = fakeDebugger();
  const cdp = new CdpSession({ api });
  cdp.setTab(7);
  await cdp.ensure();
  api.forceDetach(); // chrome did not tell us
  api.calls.length = 0;
  await cdp.send('Page.reload');
  assert.deepEqual(methods(api), ['Page.reload', 'attach', 'Page.enable', 'Runtime.enable', 'Log.enable', 'Page.reload']);
});

test('service-worker restart: already attached -> probe, then replay Runtime/Log history', async () => {
  const api = fakeDebugger({ alreadyAttached: true });
  const cdp = new CdpSession({ api });
  cdp.setTab(7);
  const infos = [];
  cdp.onAttach((i) => infos.push(i));
  await cdp.ensure();
  assert.deepEqual(methods(api), [
    'attach',
    'Runtime.evaluate',
    'Runtime.disable',
    'Log.disable',
    'Page.enable',
    'Runtime.enable',
    'Log.enable',
  ]);
  assert.deepEqual(infos, [{ generation: 1, restored: true }]);
});

test('foreign debugger owner gives an actionable error', async () => {
  const api = fakeDebugger({ alreadyAttached: true, foreignOwner: true });
  const cdp = new CdpSession({ api });
  cdp.setTab(7);
  await assert.rejects(cdp.ensure(), /Another debugger client .*Browser MCP/);
  assert.equal(cdp.attached, false);
});

test('no tab -> exact server.py contract string', async () => {
  const cdp = new CdpSession({ api: fakeDebugger() });
  await assert.rejects(cdp.send('Page.reload'), { message: 'No tab is connected' });
});

test('events: exact, domain wildcard, global; foreign tab and child sessions ignored', () => {
  const cdp = new CdpSession({ api: fakeDebugger() });
  cdp.setTab(7);
  const got = [];
  cdp.on('Runtime.consoleAPICalled', () => got.push('exact'));
  cdp.on('Runtime.*', () => got.push('domain'));
  const off = cdp.on('*', (_p, m) => got.push(`all:${m}`));
  cdp.handleEvent({ tabId: 7 }, 'Runtime.consoleAPICalled', {});
  cdp.handleEvent({ tabId: 8 }, 'Runtime.consoleAPICalled', {});
  cdp.handleEvent({ tabId: 7, sessionId: 'child' }, 'Runtime.consoleAPICalled', {});
  off();
  cdp.handleEvent({ tabId: 7 }, 'Log.entryAdded', {});
  assert.deepEqual(got, ['exact', 'domain', 'all:Runtime.consoleAPICalled']);
  assert.equal(cdp.eventCount, 2);
});

test('enable failures are reported, not swallowed', async () => {
  const cdp = new CdpSession({ api: fakeDebugger() });
  cdp.setTab(7);
  await assert.rejects(cdp.want('Broken'), /Broken\.enable failed: 'Broken\.enable' wasn't found/);
  assert.match(cdp.status().enableErrors.Broken, /wasn't found/);
});

test('CDP protocol errors are unwrapped into readable text', async () => {
  const api = fakeDebugger();
  api.sendCommand = async () => {
    throw new Error('{"code":-32000,"message":"Cannot find context with specified id"}');
  };
  const cdp = new CdpSession({ api });
  cdp.setTab(7);
  cdp.attached = true;
  await assert.rejects(cdp.send('Runtime.evaluate', {}), { message: 'Runtime.evaluate: Cannot find context with specified id' });
});
