import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactBody, redactHeaders, redactUrl, isTextMime, MASK } from '../src/shared/redact.js';
import { NetworkStore } from '../src/shared/network-store.js';

test('URL: query values, credentials and fragment are hidden; path and keys stay', () => {
  assert.equal(redactUrl('http://127.0.0.1:18765/api/json?token=DUMMY_QUERY_ONLY&x'), 'http://127.0.0.1:18765/api/json?token=***&x');
  assert.equal(redactUrl('https://user:pw@example.com/a#secret'), 'https://redacted:redacted@example.com/a#***');
  assert.equal(redactUrl('/api/json?a=1'), '/api/json?a=***');
  assert.match(redactUrl('data:image/png;base64,AAAA'), /^data:image\/png;base64,\[4 chars\]$/);
});

test('headers: safe list kept, everything else masked, URL headers redacted', () => {
  const out = redactHeaders({
    'Content-Type': 'application/json',
    'X-Test-Secret': 'DUMMY_HEADER_ONLY',
    Authorization: 'Bearer abc.def.ghi',
    Cookie: 'sid=1',
    Location: '/api/json?token=abc',
    'X-Custom': 'whatever',
  });
  assert.equal(out['Content-Type'], 'application/json');
  assert.equal(out['X-Test-Secret'], MASK);
  assert.equal(out.Authorization, MASK);
  assert.equal(out.Cookie, MASK);
  assert.equal(out['X-Custom'], MASK);
  assert.equal(out.Location, '/api/json?token=***');
});

test('JSON bodies: sensitive keys at any depth, and JSON nested in strings (acceptance fixture)', () => {
  const fixture = JSON.stringify({ ok: true, token: 'DUMMY_TOKEN_ONLY', nested: { password: 'DUMMY_PASSWORD_ONLY' } });
  const out = redactBody(fixture, 'application/json');
  assert.ok(!out.includes('DUMMY_'), out);
  assert.ok(out.includes('"ok":true'));
  const echo = JSON.stringify({ method: 'POST', received: JSON.stringify({ message: 'test', password: 'DUMMY_POST_ONLY' }) });
  const echoOut = redactBody(echo, 'application/json');
  assert.ok(!echoOut.includes('DUMMY_POST_ONLY'), echoOut);
  assert.ok(echoOut.includes('test'));
});

test('text bodies: key=value pairs, Bearer tokens and JWTs', () => {
  const out = redactBody('user=bob&password=hunter2&api_key=XYZ Authorization: Bearer abcdefghijkl eyJhbGciOi.eyJzdWIiOiIx.c2lnbmF0dXJl', 'text/plain');
  assert.ok(!out.includes('hunter2') && !out.includes('XYZ') && !out.includes('abcdefghijkl') && !out.includes('eyJzdWIiOiIx'), out);
  assert.ok(out.includes('user=bob'));
});

test('redaction is linear on huge bodies (regression: /api/large froze the worker)', () => {
  for (const big of ['x'.repeat(1_100_000), 'a=b&'.repeat(300_000), `${'eyJ'}${'a'.repeat(500_000)}`, `password${'-'.repeat(500_000)}`]) {
    const started = performance.now();
    redactBody(big, 'text/plain');
    const ms = performance.now() - started;
    assert.ok(ms < 1500, `took ${ms.toFixed(0)} ms for ${big.slice(0, 12)}…`);
  }
  const started = performance.now();
  redactBody(JSON.stringify({ blob: 'x'.repeat(1_000_000), token: 't' }), 'application/json');
  assert.ok(performance.now() - started < 1500);
});

test('text mime detection', () => {
  assert.ok(isTextMime('application/json'));
  assert.ok(isTextMime('text/html'));
  assert.ok(isTextMime('application/vnd.api+json'));
  assert.ok(!isTextMime('application/octet-stream'));
  assert.ok(!isTextMime('image/png'));
});

test('store: off by default, redirect chain, failure, limits', () => {
  const s = new NetworkStore(3);
  s.onRequestWillBeSent({ requestId: 'r0', request: { url: 'http://x/ignored', method: 'GET', headers: {} }, timestamp: 1 }, 1);
  assert.equal(s.entries.size, 0, 'nothing captured before start');
  s.start();
  s.onRequestWillBeSent({ requestId: 'r1', request: { url: 'http://x/api/redirect', method: 'GET', headers: {} }, timestamp: 1, type: 'Fetch' }, 1);
  s.onRequestWillBeSent({ requestId: 'r1', request: { url: 'http://x/api/json?token=1', method: 'GET', headers: {} }, timestamp: 1.1, redirectResponse: { status: 302, headers: { Location: '/api/json' } } }, 1);
  s.onResponseReceived({ requestId: 'r1', response: { status: 200, mimeType: 'application/json', headers: {} }, type: 'Fetch' });
  s.onLoadingFinished({ requestId: 'r1', timestamp: 1.25, encodedDataLength: 99 });
  const list = s.list(10);
  assert.deepEqual(list.requests.map((r) => [r.id, r.state, r.status]), [['n1', 'redirected', 302], ['n2', 'finished', 200]]);
  assert.equal(list.requests[0].redirectedTo, 'n2');
  assert.equal(list.requests[1].url, 'http://x/api/json?token=***');
  assert.equal(list.requests[1].durationMs, 150);
  assert.equal(s.detail('n2').redirectedFrom, 'n1');

  s.onRequestWillBeSent({ requestId: 'r2', request: { url: 'http://x/missing', method: 'GET', headers: {} }, timestamp: 2 }, 1);
  s.onLoadingFailed({ requestId: 'r2', timestamp: 2.1, errorText: 'net::ERR_CONNECTION_REFUSED' });
  assert.equal(s.get('n3').state, 'failed');
  s.onRequestWillBeSent({ requestId: 'r3', request: { url: 'http://x/4', method: 'POST', headers: {}, hasPostData: true }, timestamp: 3 }, 1);
  assert.equal(s.entries.size, 3);
  assert.equal(s.dropped, 1);
  assert.ok(!s.get('n1'));
  assert.throws(() => s.detail('n1'), /Unknown request_id/);
  s.clear();
  assert.equal(s.list(10).returned, 0);
});
