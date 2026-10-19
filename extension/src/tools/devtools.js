// @ts-check
import { RingBuffer } from '../shared/ring-buffer.js';
import { formatRemoteObject } from '../shared/console-store.js';
import { clipJson, errorMessage, intInRange } from '../shared/util.js';
import { cdpNavigationBlockReason } from './navigation.js';

/** Domains that reach beyond the connected tab or kill the browser. */
export const DENIED_DOMAINS = new Set(['Browser', 'Target', 'SystemInfo', 'Tethering', 'Extensions', 'PWA']);
/** Single methods that would break the extension or the tab. */
export const DENIED_METHODS = new Map([
  ['Page.close', 'closes the tab'],
  ['Page.crash', 'crashes the renderer'],
  ['Runtime.disable', 'stops console capture; Browser Control keeps Runtime enabled'],
  ['Log.disable', 'stops console capture; Browser Control keeps Log enabled'],
  ['Page.disable', 'breaks navigation tracking; Browser Control keeps Page enabled'],
  ['Network.disable', 'use browser_network action=stop instead'],
  ['Network.enable', 'use browser_network action=start instead'],
  // Browser-wide: cookies/storage/cache of every site, not just this tab.
  ['Network.getAllCookies', 'returns the cookies of every site in the browser; use Network.getCookies without urls (cookies of this page)'],
  ['Network.clearBrowserCookies', 'deletes the cookies of every site in the browser'],
  ['Network.clearBrowserCache', 'clears the cache of the whole browser'],
  ['Storage.getCookies', 'returns the cookies of every site in the browser; use Network.getCookies without urls (cookies of this page)'],
  ['Storage.setCookies', 'writes cookies of any site in the browser'],
  ['Storage.clearCookies', 'deletes the cookies of every site in the browser'],
  ['Storage.clearDataForOrigin', 'wipes storage of an arbitrary origin'],
  ['Storage.clearDataForStorageKey', 'wipes storage of an arbitrary origin'],
  // reads any URL (other sites, intranet, localhost) with the browser's
  // network stack and no CORS.
  ['Network.loadNetworkResource', 'loads any URL of any site, intranet or localhost past CORS; use browser_evaluate with fetch() from the page instead'],
]);

/** @param {string} host @param {string} domain cookie domain, optionally with a leading dot */
function hostInDomain(host, domain) {
  const d = String(domain || '').replace(/^\./, '').toLowerCase();
  const h = String(host || '').toLowerCase();
  return !!d && (h === d || h.endsWith(`.${d}`));
}

/** @param {string} raw */
function safeUrl(raw) {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/**
 * Parameters that point outside the connected tab's site/origin:
 * cookies written/deleted for another domain (Network.setCookie(s),
 * deleteCookies) and storage methods with another origin / storage key
 * (Storage.getUsageAndQuota, Storage.track*ForOrigin, ...).
 * @param {string} method
 * @param {any} params
 * @param {string} tabUrl URL of the connected tab
 * @returns {string | null}
 */
export function scopeReason(method, params, tabUrl) {
  if (!params || typeof params !== 'object') return null;
  const tab = safeUrl(tabUrl);
  const host = tab ? tab.hostname : '';
  const origin = tab ? tab.origin : 'null';
  const cookieTargets = [];
  if (method === 'Network.setCookie' || method === 'Network.deleteCookies') cookieTargets.push(params);
  if (method === 'Network.setCookies' && Array.isArray(params.cookies)) cookieTargets.push(...params.cookies);
  for (const c of cookieTargets) {
    if (!c || typeof c !== 'object') continue;
    if (c.domain !== undefined && !hostInDomain(host, c.domain)) return `cookies may only be set or deleted for the site of this tab (${host || 'none'}), not for ${c.domain}`;
    if (c.url !== undefined) {
      const u = safeUrl(String(c.url));
      if (!u || !hostInDomain(u.hostname, host)) return `cookies may only be set or deleted for the site of this tab (${host || 'none'}), not for ${String(c.url).slice(0, 80)}`;
    }
  }
  for (const key of ['origin', 'securityOrigin']) {
    if (typeof params[key] === 'string' && params[key].replace(/\/$/, '') !== origin) {
      return `${key} must be the origin of this tab (${origin}); other sites' storage is off limits`;
    }
  }
  // "https://a.com.evil.com/" also starts with "https://a.com": compare up to the slash.
  if (typeof params.storageKey === 'string' && params.storageKey !== origin && !params.storageKey.startsWith(`${origin}/`)) {
    return `storageKey must belong to the origin of this tab (${origin}); other sites' storage is off limits`;
  }
  return null;
}

/**
 * @param {string} method
 * @param {any} [params] checked for the few methods whose parameters can reach other sites
 * @returns {string | null} reason it is refused
 */
export function deniedReason(method, params) {
  if (typeof method !== 'string' || !/^[A-Z][A-Za-z0-9]*\.[a-z][A-Za-z0-9]*$/.test(method)) {
    return 'method must look like Domain.command, e.g. DOM.getDocument';
  }
  const domain = method.slice(0, method.indexOf('.'));
  if (DENIED_DOMAINS.has(domain)) return `the ${domain} domain reaches beyond the connected tab`;
  if (DENIED_METHODS.has(method)) return DENIED_METHODS.get(method) || 'not allowed';
  if (method === 'Network.getCookies' && params && params.urls !== undefined) {
    return 'the urls parameter reads cookies of any site; call it without urls to get the cookies of this page';
  }
  return null;
}

const DOMAIN_RE = /^[A-Z][A-Za-z0-9]*$/;
/** Domains Browser Control manages itself (enabled/disabled by their own tools). */
const MANAGED = new Set(['Page', 'Runtime', 'Log', 'Network']);
/** Object subtypes that are described, not serialized (JSON would be {} or lossy). */
const NON_JSON_SUBTYPES = new Set(['node', 'error', 'regexp', 'date', 'map', 'set', 'weakmap', 'weakset', 'promise', 'proxy', 'generator', 'iterator', 'arraybuffer', 'dataview', 'typedarray', 'wasmvalue', 'trustedtype']);

/** Buffer of raw CDP events for domains the AI subscribed to. */
export class CdpEventStore {
  constructor(capacity = 1000) {
    /** @type {Set<string>} */
    this.subscribed = new Set();
    /** @type {Set<string>} domains enabled on behalf of the AI */
    this.enabledByUs = new Set();
    /** @type {RingBuffer<{seq: number, time: string, method: string, params: unknown}>} */
    this.buffer = new RingBuffer(capacity);
    this.seq = 0;
  }

  /** @param {string} method @param {any} params */
  onEvent(method, params) {
    const domain = method.slice(0, method.indexOf('.'));
    if (!this.subscribed.has(domain)) return;
    this.seq += 1;
    this.buffer.push({ seq: this.seq, time: new Date().toISOString(), method, params: clipJson(params, 4000) });
  }

  stats() {
    return { subscribed: [...this.subscribed], buffered: this.buffer.size, total: this.buffer.total, dropped: this.buffer.dropped };
  }
}

/** @param {any} ctx */
export function devtoolsHandlers(ctx) {
  /** @type {CdpEventStore} */
  const events = ctx.cdpEvents;

  return {
    async browser_cdp({ method, params = {} }) {
      ctx.session.requireTab();
      const reason = deniedReason(method, params);
      if (reason) throw new Error(`${method} is not allowed: ${reason}`);
      if (params === null || typeof params !== 'object' || Array.isArray(params)) throw new Error('params must be a JSON object');
      const tab = await chrome.tabs.get(ctx.session.requireTab());
      const scoped = scopeReason(method, params, tab.url || tab.pendingUrl || '');
      if (scoped) throw new Error(`${method} is not allowed: ${scoped}`);
      const nav = await cdpNavigationBlockReason(ctx, method, params);
      if (nav) throw new Error(`${method} is not allowed: ${nav}. Use browser_navigate for regular pages.`);
      const result = await ctx.cdp.send(method, params, 30_000);
      return result ?? {};
    },

    async browser_evaluate({ expression, awaitPromise = true }) {
      ctx.session.requireTab();
      if (typeof expression !== 'string' || !expression.trim()) throw new Error('expression is required');
      // Evaluate by reference first: DOM nodes, functions, Maps etc. keep a
      // meaningful description instead of collapsing to {} with returnByValue.
      let r = await ctx.cdp.send(
        'Runtime.evaluate',
        { expression, awaitPromise: !!awaitPromise, returnByValue: false, userGesture: true, replMode: true, allowUnsafeEvalBlockedByCSP: true, generatePreview: true, objectGroup: 'bc-evaluate' },
        30_000,
      );
      // in replMode awaitPromise only covers top-level await; a
      // returned Promise, e.g. (async () => ...)(), came back pending.
      if (awaitPromise && !r.exceptionDetails && r.result && r.result.subtype === 'promise' && r.result.objectId) {
        r = await ctx.cdp.send('Runtime.awaitPromise', { promiseObjectId: r.result.objectId, returnByValue: false, generatePreview: true }, 30_000);
      }
      try {
        const obj = r.result || {};
        if (r.exceptionDetails) {
          const d = r.exceptionDetails;
          // Line/column are omitted: replMode wraps the code, so they are offset.
          return { ok: false, exception: { text: (d.exception && d.exception.description) || d.text } };
        }
        const out = { ok: true, type: obj.type, subtype: obj.subtype };
        if (obj.unserializableValue) out.value = obj.unserializableValue;
        else if ('value' in obj) out.value = obj.value;
        else if (obj.type === 'undefined') out.value = null;
        else if (obj.objectId && obj.type === 'object' && !NON_JSON_SUBTYPES.has(obj.subtype || '')) {
          try {
            const json = await ctx.cdp.send('Runtime.callFunctionOn', { objectId: obj.objectId, functionDeclaration: 'function () { return this; }', returnByValue: true }, 10_000);
            if (json.exceptionDetails || !json.result || !('value' in json.result)) out.description = formatRemoteObject(obj);
            else out.value = json.result.value;
          } catch {
            out.description = formatRemoteObject(obj); // cyclic or too deep
          }
        } else {
          out.description = formatRemoteObject(obj);
        }
        return out;
      } finally {
        ctx.cdp.send('Runtime.releaseObjectGroup', { objectGroup: 'bc-evaluate' }, 5000).catch(() => {});
      }
    },

    async browser_cdp_events({ action = 'read', domain = '', limit = 100 }) {
      ctx.session.requireTab();
      switch (action) {
        case 'subscribe': {
          if (!DOMAIN_RE.test(domain)) throw new Error('domain must be a CDP domain name, e.g. Performance or DOM');
          if (DENIED_DOMAINS.has(domain)) throw new Error(`the ${domain} domain is not allowed`);
          events.subscribed.add(domain);
          let note = null;
          if (!MANAGED.has(domain)) {
            try {
              await ctx.cdp.want(domain);
              events.enabledByUs.add(domain);
            } catch (error) {
              // Do not leave it in cdp.wanted: it would be re-enabled on every
              // re-attach and unsubscribe would never drop it.
              await ctx.cdp.unwant(domain).catch(() => {});
              note = `${domain}.enable failed (${errorMessage(error)}); events arrive only if something else enables the domain. Subscribe again once the tab shows a regular page.`;
            }
          } else if (domain === 'Network' && !ctx.networkStore.enabled) {
            note = 'Network events flow only while browser_network capture is started.';
          }
          return { ...events.stats(), note };
        }
        case 'unsubscribe':
          events.subscribed.delete(domain);
          events.enabledByUs.delete(domain);
          // Any domain we may have asked for, even if enable failed back then.
          if (!MANAGED.has(domain)) await ctx.cdp.unwant(domain);
          return events.stats();
        case 'clear':
          events.buffer.clear();
          return events.stats();
        case 'read': {
          const max = intInRange(limit, 1, 500, 'limit');
          const items = domain ? events.buffer.items.filter((e) => e.method.startsWith(`${domain}.`)) : events.buffer.items;
          return { ...events.stats(), returned: Math.min(max, items.length), events: items.slice(-max) };
        }
        default:
          throw new Error('action must be subscribe, unsubscribe, read or clear');
      }
    },
  };
}
