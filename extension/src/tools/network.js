// @ts-check
import { isTextMime, redactBody } from '../shared/redact.js';
import { errorMessage, intInRange } from '../shared/util.js';

const MAX_BODY_SOURCE = 2_000_000; // bodies above this are refused, not truncated

/** @param {string} b64 */
function decodeBase64Utf8(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

/** @param {any} ctx */
export function networkHandlers(ctx) {
  const store = ctx.networkStore;

  async function body(requestId, part, maxChars) {
    const e = store.get(requestId);
    if (!e) throw new Error(`Unknown request_id "${requestId}". Call browser_network action=list first.`);
    const base = { request_id: requestId, part, url: e.url, mimeType: e.mimeType ?? null };
    const unavailable = (reason) => ({ ...base, available: false, reason });
    if (!store.enabled) return unavailable('Network capture is stopped; bodies can be read only while capture is on.');
    if (e.generation !== ctx.cdp.generation) return unavailable('The debugger re-attached after this request; Chrome dropped its body.');
    let text;
    if (part === 'request') {
      if (!e.hasPostData) return unavailable('This request has no body.');
      try {
        const r = await ctx.cdp.send('Network.getRequestPostData', { requestId: e.cdpId });
        text = r.postData;
      } catch (error) {
        return unavailable(`Chrome did not keep the request body: ${errorMessage(error)}`);
      }
    } else {
      if (e.state === 'redirected') return unavailable(`Redirect (${e.status}) has no body; see ${e.redirectedTo}.`);
      if (e.state === 'pending') return unavailable('The response is still loading.');
      if (e.state === 'failed') return unavailable(`The request failed: ${e.errorText}`);
      let r;
      try {
        r = await ctx.cdp.send('Network.getResponseBody', { requestId: e.cdpId });
      } catch (error) {
        return unavailable(`Chrome no longer has this body (evicted, cached or streamed): ${errorMessage(error)}`);
      }
      if (r.base64Encoded) {
        if (!isTextMime(e.mimeType)) return unavailable(`Binary body (${e.mimeType || 'unknown type'}) is not returned.`);
        if (r.body.length > MAX_BODY_SOURCE * 1.4) return unavailable('Body is larger than 2 MB.');
        text = decodeBase64Utf8(r.body);
      } else {
        text = r.body;
      }
    }
    text = String(text ?? '');
    if (text.length > MAX_BODY_SOURCE) return unavailable(`Body is larger than 2 MB (${text.length} chars).`);
    // Non-JSON text is redacted only as far as it will be returned (+ margin
    // for a key/value cut at the edge): bounded work on multi-MB bodies.
    const isJson = /json/i.test(e.mimeType || '') || /^\s*[[{]/.test(text.slice(0, 64));
    const source = !isJson && text.length > maxChars + 4096 ? text.slice(0, maxChars + 4096) : text;
    const redacted = redactBody(source, e.mimeType);
    return {
      ...base,
      available: true,
      length: text.length,
      truncated: redacted.length > maxChars,
      body: redacted.slice(0, maxChars),
      note: 'Best-effort redaction of secrets; NOT a guarantee of anonymization.',
    };
  }

  return {
    async browser_network({ action = 'list', request_id = '', limit = 50, part = 'response', max_chars = 16384 }) {
      ctx.session.requireTab();
      switch (action) {
        case 'start':
          store.start();
          try {
            await ctx.cdp.want('Network');
          } catch (error) {
            store.stop();
            throw error;
          }
          return { enabled: true, note: 'Only requests made from now on are captured. Reload the page to see its initial requests.' };
        case 'stop':
          store.stop();
          await ctx.cdp.unwant('Network');
          return { enabled: false, kept: store.entries.size };
        case 'clear':
          store.clear();
          return { cleared: true, enabled: store.enabled };
        case 'list':
          return store.list(intInRange(limit, 1, 300, 'limit'));
        case 'detail':
          if (!request_id) throw new Error('request_id is required; call action=list first');
          return store.detail(request_id);
        case 'body':
          if (!request_id) throw new Error('request_id is required; call action=list first');
          if (part !== 'request' && part !== 'response') throw new Error('part must be request or response');
          return body(request_id, part, intInRange(max_chars, 1, 65536, 'max_chars'));
        default:
          throw new Error('action must be start, stop, clear, list, detail or body');
      }
    },
  };
}
