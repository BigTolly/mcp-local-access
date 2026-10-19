import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { rasterizeIcon, ICON_COLORS, parseHex } from '../src/shared/icon-raster.js';
import { captureParams } from '../src/tools/capture.js';
import { deniedReason, CdpEventStore, scopeReason } from '../src/tools/devtools.js';
import { normalizeUrl, navigationBlockReason, cdpNavigationBlockReason } from '../src/tools/navigation.js';
import { automationBlockReason } from '../src/background/session.js';
import { explainInjectionError } from '../src/background/page-agent.js';

// ---------------------------------------------------------------- agent ---
function loadAgent() {
  const sandbox = { globalThis: null };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(new URL('../src/page/agent.js', import.meta.url), 'utf8'), sandbox);
  return sandbox.__browserControl;
}

test('agent loads in isolation and is idempotent', () => {
  const agent = loadAgent();
  assert.equal(agent.version, '1.0.0');
  assert.equal(typeof agent.call, 'function');
});

test('agent renders the Playwright-style YAML with refs', () => {
  const { render } = loadAgent()._internals;
  const node = (role, name, extra = {}) => ({ role, name, props: [], ref: extra.ref || 's1e1', value: null, url: null, children: [], ...extra });
  const tree = [
    'Intro text ',
    node('heading', 'Title', { props: ['level=1'], ref: 's1e2', children: ['Title'] }),
    node('button', 'Click me', { ref: 's1e3', children: ['Click me'] }),
    node('textbox', 'Name', { ref: 's1e4', value: 'Привет 🚀' }),
    node('checkbox', 'Agree', { ref: 's1e5', props: ['checked'] }),
    node('link', 'Home', { ref: 's1e6', url: '/home', children: ['Home'] }),
    node('list', '', { ref: 's1e7', children: [node('listitem', '', { ref: 's1e8', children: ['Item: one'] })] }),
    node('generic', '', { ref: 's1e9', props: ['cursor=pointer'], children: ['Open menu'] }),
  ];
  const yaml = render(tree, 0, []).join('\n');
  assert.equal(
    yaml,
    [
      '- text: Intro text',
      '- heading "Title" [level=1] [ref=s1e2]',
      '- button "Click me" [ref=s1e3]',
      '- textbox "Name" [ref=s1e4]: Привет 🚀',
      '- checkbox "Agree" [checked] [ref=s1e5]',
      '- link "Home" [ref=s1e6]:',
      '  - /url: /home',
      '- list [ref=s1e7]:',
      '  - listitem [ref=s1e8]: "Item: one"',
      '- generic [cursor=pointer] [ref=s1e9]: Open menu',
    ].join('\n'),
  );
});

test('agent rejects malformed and missing refs with the donor-compatible messages', async () => {
  const agent = loadAgent();
  // objects come from another vm realm: compare fields, not prototypes
  const bad = await agent.call('point', { ref: 'button' });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'Invalid aria-ref selector, should be of form s<number>e<number>');
  const none = await agent.call('point', { ref: 's1e2' });
  assert.equal(none.error, 'No snapshot found. Please generate an aria snapshot before trying again.');
  assert.match((await agent.call('nope', {})).error, /Unknown page command/);
});

// ---------------------------------------------------------------- icon ---
test('icon: transparent background, only line pixels carry color', () => {
  for (const size of [16, 32, 128]) {
    const px = rasterizeIcon(size, ICON_COLORS.connected);
    assert.equal(px.length, size * size * 4);
    assert.equal(px[3], 0, 'top-left corner is transparent');
    assert.equal(px[(size * size - 1) * 4 + 3], 0, 'bottom-right corner is transparent');
    const center = (Math.floor(size * 0.55) * size + Math.floor(size * 0.25)) * 4;
    assert.equal(px[center + 3], 0, 'inside of the window has no fill');
    let ink = 0;
    for (let i = 3; i < px.length; i += 4) if (px[i] > 128) ink++;
    const share = ink / (size * size);
    assert.ok(share > 0.08 && share < 0.45, `ink share ${share.toFixed(2)} at ${size}px`);
  }
  const [r, g, b] = parseHex(ICON_COLORS.connected);
  const px = rasterizeIcon(32, ICON_COLORS.connected);
  const i = px.findIndex((v, idx) => idx % 4 === 3 && v === 255) - 3;
  assert.deepEqual([px[i], px[i + 1], px[i + 2]], [r, g, b]);
  assert.notEqual(ICON_COLORS.light, ICON_COLORS.dark);
});

// ---------------------------------------------------------------- capture ---
const metrics = { css: { pageX: 0, pageY: 300, clientWidth: 1280, clientHeight: 720 }, content: { width: 1280, height: 5000 }, dpr: 2 };

test('capture: viewport original has no clip, reduced fits 1024x768', () => {
  assert.equal(captureParams({ mode: 'viewport', scale: 'original' }, metrics).params.clip, undefined);
  const reduced = captureParams({ mode: 'viewport', scale: 'reduced' }, metrics);
  assert.ok(reduced.expected.width <= 1024 && reduced.expected.height <= 768, JSON.stringify(reduced.expected));
  assert.equal(reduced.params.clip.y, 300);
});

test('capture: full page covers the document and respects the pixel/side limits', () => {
  const full = captureParams({ mode: 'full_page', scale: 'original' }, metrics);
  assert.equal(full.params.captureBeyondViewport, true);
  assert.deepEqual([full.params.clip.x, full.params.clip.y, full.params.clip.width, full.params.clip.height], [0, 0, 1280, 5000]);
  assert.ok(full.expected.width * full.expected.height <= 16_000_000 + 1);
  const tall = captureParams({ mode: 'full_page', scale: 'original' }, { ...metrics, dpr: 1, content: { width: 800, height: 40000 } });
  assert.ok(tall.expected.height <= 16384, JSON.stringify(tall.expected));
});

// ---------------------------------------------------------------- devtools ---
test('CDP allow/deny list', () => {
  assert.equal(deniedReason('DOM.getDocument'), null);
  assert.equal(deniedReason('Performance.getMetrics'), null);
  assert.match(deniedReason('Browser.close'), /beyond the connected tab/);
  assert.match(deniedReason('Target.createTarget'), /beyond/);
  assert.match(deniedReason('Runtime.disable'), /console capture/);
  assert.match(deniedReason('Page.close'), /closes the tab/);
  assert.match(deniedReason('getDocument'), /Domain\.command/);
});

test('CDP: browser-wide cookie/storage methods are refused, page cookies are not', () => {
  for (const m of ['Network.getAllCookies', 'Storage.getCookies', 'Network.clearBrowserCookies', 'Network.clearBrowserCache', 'Storage.clearDataForOrigin', 'Storage.setCookies']) {
    assert.match(deniedReason(m) || '', /every site|any site|whole browser|arbitrary origin/, m);
  }
  assert.equal(deniedReason('Network.getCookies'), null);
  assert.equal(deniedReason('Network.getCookies', {}), null);
  assert.match(deniedReason('Network.getCookies', { urls: ['https://mail.example.com'] }), /any site/);
});

test('CDP: loadNetworkResource is refused', () => {
  assert.match(deniedReason('Network.loadNetworkResource', { url: 'http://127.0.0.1:18766/' }) || '', /past CORS/);
  assert.equal(deniedReason('IO.read', { handle: '1' }), null);
});

test('CDP: cookies and storage only for the site of the tab', () => {
  const tab = 'https://mail.example.com/inbox';
  assert.equal(scopeReason('Network.setCookie', { name: 'a', value: '1', domain: '.example.com' }, tab), null);
  assert.equal(scopeReason('Network.setCookie', { name: 'a', value: '1', domain: 'mail.example.com' }, tab), null);
  assert.equal(scopeReason('Network.setCookie', { name: 'a', value: '1', url: 'https://mail.example.com/' }, tab), null);
  assert.match(scopeReason('Network.setCookie', { name: 'a', value: '1', domain: 'bank.test' }, tab) || '', /site of this tab/);
  assert.match(scopeReason('Network.setCookie', { name: 'a', value: '1', url: 'https://bank.test/' }, tab) || '', /site of this tab/);
  assert.match(scopeReason('Network.deleteCookies', { name: 'sid', domain: 'evilexample.com' }, tab) || '', /site of this tab/);
  assert.match(scopeReason('Network.setCookies', { cookies: [{ name: 'a', value: '1', domain: 'example.com' }, { name: 'b', value: '2', domain: 'other.test' }] }, tab) || '', /other\.test/);
  assert.equal(scopeReason('Storage.getUsageAndQuota', { origin: 'https://mail.example.com' }, tab), null);
  assert.equal(scopeReason('Storage.getUsageAndQuota', { origin: 'https://mail.example.com/' }, tab), null);
  assert.match(scopeReason('Storage.getUsageAndQuota', { origin: 'https://example.org' }, tab) || '', /origin of this tab/);
  assert.match(scopeReason('CacheStorage.requestCacheNames', { securityOrigin: 'https://example.org' }, tab) || '', /origin of this tab/);
  assert.equal(scopeReason('IndexedDB.requestDatabaseNames', { storageKey: 'https://mail.example.com/' }, tab), null);
  assert.match(scopeReason('IndexedDB.requestDatabaseNames', { storageKey: 'https://mail.example.com.evil.test/' }, tab) || '', /storageKey/);
  assert.equal(scopeReason('DOM.getDocument', { depth: 1 }, tab), null);
});

test('CDP: Page.navigate / navigateToHistoryEntry get the browser_navigate checks', async () => {
  const ctx = {
    getSettings: () => ({ allowFileUrls: false }),
    cdp: { send: async () => ({ currentIndex: 1, entries: [{ id: 1, url: 'chrome://version/' }, { id: 2, url: 'https://example.com/' }, { id: 3, url: 'file:///C:/' }] }) },
  };
  assert.match(await cdpNavigationBlockReason(ctx, 'Page.navigate', { url: 'chrome://version' }) || '', /forbids/);
  assert.match(await cdpNavigationBlockReason(ctx, 'Page.navigate', { url: 'javascript:1' }) || '', /browser_evaluate/);
  assert.match(await cdpNavigationBlockReason(ctx, 'Page.navigate', { url: 'file:///C:/' }) || '', /file:\/\//);
  assert.equal(await cdpNavigationBlockReason(ctx, 'Page.navigate', { url: 'https://example.com/' }), null);
  assert.match(await cdpNavigationBlockReason(ctx, 'Page.navigateToHistoryEntry', { entryId: 1 }) || '', /forbids/);
  assert.match(await cdpNavigationBlockReason(ctx, 'Page.navigateToHistoryEntry', { entryId: 3 }) || '', /file/);
  assert.equal(await cdpNavigationBlockReason(ctx, 'Page.navigateToHistoryEntry', { entryId: 2 }), null);
  assert.equal(await cdpNavigationBlockReason(ctx, 'DOM.getDocument', {}), null);
});

test('CDP event store keeps only subscribed domains and clips big params', () => {
  const s = new CdpEventStore(10);
  s.onEvent('Performance.metrics', { a: 1 });
  s.subscribed.add('Performance');
  s.onEvent('Performance.metrics', { a: 1 });
  s.onEvent('DOM.documentUpdated', {});
  s.onEvent('Performance.metrics', { big: 'x'.repeat(10000) });
  assert.equal(s.buffer.size, 2);
  assert.equal(s.buffer.items[1].params.truncated, true);
});

// ---------------------------------------------------------------- misc ---
test('URL normalization like the address bar', () => {
  assert.equal(normalizeUrl('https://example.com'), 'https://example.com');
  assert.equal(normalizeUrl('example.com/a'), 'https://example.com/a');
  assert.equal(normalizeUrl('localhost:3000'), 'http://localhost:3000');
  assert.equal(normalizeUrl('127.0.0.1:18765/acceptance.html'), 'http://127.0.0.1:18765/acceptance.html');
  assert.equal(normalizeUrl('about:blank'), 'about:blank');
  assert.throws(() => normalizeUrl(''), /url is required/);
  assert.equal(normalizeUrl('javascript:1'), 'javascript:1');
  assert.equal(normalizeUrl('JavaScript:void(0)'), 'JavaScript:void(0)');
  assert.equal(normalizeUrl('data:1'), 'data:1');
  assert.equal(normalizeUrl('myhost:8080/x'), 'https://myhost:8080/x');
});

test('navigate refuses pages that would kick the debugger out', () => {
  assert.match(navigationBlockReason(normalizeUrl('chrome://settings')), /forbids extensions/);
  assert.match(navigationBlockReason('chrome-extension://abc/popup.html'), /forbids/);
  assert.match(navigationBlockReason('https://chromewebstore.google.com/detail/x'), /forbids/);
  assert.match(navigationBlockReason(normalizeUrl('javascript:document.title=1')), /browser_evaluate/);
  assert.equal(navigationBlockReason('https://example.com/'), null);
  assert.equal(navigationBlockReason('about:blank'), null);
  assert.equal(navigationBlockReason(normalizeUrl('127.0.0.1:18765/acceptance.html')), null);
  assert.match(navigationBlockReason(normalizeUrl('javascript:1')), /browser_evaluate/);
});

test('navigate refuses file:// unless allowed in the popup', () => {
  assert.match(navigationBlockReason(normalizeUrl('file:///C:/')), /whole local disk/);
  assert.match(navigationBlockReason('FILE:///etc/passwd'), /whole local disk/);
  assert.equal(navigationBlockReason('file:///C:/', { allowFile: true }), null);
  assert.match(navigationBlockReason('chrome://settings', { allowFile: true }), /forbids/);
});

test('pages Chrome forbids are explained up front', () => {
  assert.match(automationBlockReason('chrome://extensions/'), /does not allow/);
  assert.match(automationBlockReason('https://chromewebstore.google.com/detail/x'), /Web Store/);
  assert.equal(automationBlockReason('https://example.com/'), null);
  assert.equal(automationBlockReason('about:blank'), null);
  assert.match(explainInjectionError('Cannot access contents of url "chrome://newtab/"'), /cannot be automated/);
  assert.equal(explainInjectionError('No tab with id: 5.'), 'No tab is connected');
});
