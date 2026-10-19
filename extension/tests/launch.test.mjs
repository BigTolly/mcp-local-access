// Agent browser session helpers: launch URL parsing and bridge URLs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLaunchUrl, bridgeUrl, probeLaunch } from '../src/background/launch.js';

const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWx_-12';

test('parseLaunchUrl accepts only the local launch page with a token', () => {
  assert.deepEqual(parseLaunchUrl(`http://127.0.0.1:9009/bc-launch#${TOKEN}`), { port: 9009, token: TOKEN });
  assert.deepEqual(parseLaunchUrl(`http://localhost:9010/bc-launch/#${TOKEN}`), { port: 9010, token: TOKEN });
  assert.equal(parseLaunchUrl(`https://127.0.0.1:9009/bc-launch#${TOKEN}`), null);
  assert.equal(parseLaunchUrl(`http://evil.example:9009/bc-launch#${TOKEN}`), null);
  assert.equal(parseLaunchUrl(`http://127.0.0.1:9009/bc-launch?x=1#${TOKEN}`), null);
  assert.equal(parseLaunchUrl('http://127.0.0.1:9009/bc-launch#short'), null);
  assert.equal(parseLaunchUrl('http://127.0.0.1:9009/bc-launch'), null);
  assert.equal(parseLaunchUrl(undefined), null);
});

test('bridgeUrl keeps the old URL without a token', () => {
  assert.equal(bridgeUrl('localhost', 9009, null), 'ws://localhost:9009');
  assert.equal(bridgeUrl('localhost', 9009, TOKEN), `ws://localhost:9009/?launch=${TOKEN}`);
  assert.equal(bridgeUrl('localhost', 9009, TOKEN, true), `ws://localhost:9009/?launch=${TOKEN}&probe=1`);
});

class FakeSocket {
  /** @param {string} url */
  constructor(url) {
    this.url = url;
    FakeSocket.last = this;
  }
  close() {}
}

test('probeLaunch resolves true only on launchAccepted', async () => {
  const ok = probeLaunch('ws://x', { WebSocketImpl: /** @type {any} */ (FakeSocket) });
  FakeSocket.last.onmessage({ data: JSON.stringify({ type: 'launchAccepted' }) });
  assert.equal(await ok, true);

  const refused = probeLaunch('ws://x', { WebSocketImpl: /** @type {any} */ (FakeSocket) });
  FakeSocket.last.onclose({ code: 4403 });
  assert.equal(await refused, false);

  const silent = probeLaunch('ws://x', { WebSocketImpl: /** @type {any} */ (FakeSocket), timeoutMs: 50 });
  assert.equal(await silent, false);
});
