// @ts-check
import { waitForNavigation, waitTabReady } from '../background/wait.js';
import { automationBlockReason } from '../background/session.js';
import { errorMessage } from '../shared/util.js';

const NAV_TIMEOUT_MS = 25_000; // server.py waits 30 s for an answer

/**
 * Schemes that are never a "host:port" pair. Checked before the host:port
 * heuristic, otherwise "javascript:1" became https://javascript:1.
 */
const KNOWN_SCHEME = /^(https?|wss?|ftp|file|data|blob|filesystem|javascript|about|mailto|tel|intent|view-source|chrome|chrome-extension|chrome-untrusted|chrome-search|devtools|edge):/i;

/** Accept "example.com" and "localhost:3000" like the address bar does. */
export function normalizeUrl(input) {
  const url = String(input ?? '').trim();
  if (!url) throw new Error('url is required');
  if (KNOWN_SCHEME.test(url)) return url;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) && !/^(localhost|[\w-]+(\.[\w-]+)*):\d+/i.test(url)) return url;
  if (url.startsWith('//')) return `https:${url}`;
  const local = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0)(:\d+)?(\/|$)/i.test(url);
  const candidate = `${local ? 'http' : 'https'}://${url}`;
  try {
    new URL(candidate);
  } catch {
    throw new Error(`Not a valid URL: ${url}`);
  }
  return candidate;
}

/**
 * Why browser_navigate refuses a URL, or null. Opening a chrome:// (or Web
 * Store, devtools://, ...) page kicks the debugger out of the tab, and from
 * there no CDP-based tool can bring it back.
 * file:// is refused unless the user allowed it in the popup: with "Allow
 * access to file URLs" on, it hands the AI the whole local disk, outside the
 * Local Access permissions.
 * @param {string} target normalized URL
 * @param {{ allowFile?: boolean }} [options]
 */
export function navigationBlockReason(target, options = {}) {
  if (/^javascript:/i.test(target)) return 'javascript: URLs replace the page with their result; use browser_evaluate to run code in the page';
  if (/^file:/i.test(target) && !options.allowFile) {
    return 'file:// pages expose the whole local disk, outside the Local Access folder and its rules; the user can allow them in the Browser Control popup (Settings: "Allow file:// pages")';
  }
  if (automationBlockReason(target)) return 'Chrome forbids extensions to control this page, so the tab would drop out of Browser Control';
  return null;
}

/** @returns {Promise<boolean>} */
function fileAccessAllowed() {
  return new Promise((resolve) => {
    try {
      chrome.extension.isAllowedFileSchemeAccess((allowed) => resolve(!!allowed));
    } catch {
      resolve(false);
    }
  });
}

/**
 * A page the debugger cannot stay on: chrome://, Web Store..., and file://
 * while "Allow access to file URLs" is off for the extension.
 * @param {number} tabId
 */
async function onProtectedPage(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const url = tab.url || tab.pendingUrl || '';
  if (automationBlockReason(url)) return true;
  if (/^file:/i.test(url)) return !(await fileAccessAllowed());
  return false;
}

/** @param {any} ctx */
function navOptions(ctx) {
  const settings = typeof ctx.getSettings === 'function' ? ctx.getSettings() : {};
  return { allowFile: !!(settings && settings.allowFileUrls) };
}

/**
 * Same refusal for browser_cdp Page.navigate / Page.navigateToHistoryEntry,
 * which used to bypass browser_navigate's checks.
 * @param {any} ctx @param {string} method @param {any} params
 * @returns {Promise<string | null>}
 */
export async function cdpNavigationBlockReason(ctx, method, params) {
  if (method === 'Page.navigate') {
    const url = params && typeof params.url === 'string' ? params.url : '';
    if (!url) return null; // CDP reports the missing parameter itself
    return navigationBlockReason(normalizeUrl(url), navOptions(ctx));
  }
  if (method === 'Page.navigateToHistoryEntry') {
    const history = await ctx.cdp.send('Page.getNavigationHistory');
    const entry = (history.entries || []).find((e) => e.id === (params && params.entryId));
    return entry ? navigationBlockReason(entry.url || '', navOptions(ctx)) : null;
  }
  return null;
}

/** Chrome's own refusal ("Not allowed") for e.g. the Web Store, made readable. @param {string} target @param {unknown} error */
function explainNavigateError(target, error) {
  const message = errorMessage(error);
  if (/not allowed/i.test(message)) {
    return new Error(`Chrome does not allow extensions to open ${target.split(/[?#]/)[0].slice(0, 100)} (Chrome Web Store, a page protected by policy or a redirect to one). The tab stays where it was.`);
  }
  return error instanceof Error ? error : new Error(message);
}

/** @param {any} ctx */
async function settle(ctx, tabId) {
  await waitTabReady(tabId, 10_000).catch(() => {});
  await ctx.agent.call(tabId, 'waitForStable', { quietMs: 250, maxMs: 1500 }).catch(() => {});
}

/** @param {any} ctx @param {number} delta */
async function historyStep(ctx, delta) {
  const tabId = ctx.session.requireTab();
  const word = delta < 0 ? 'back' : 'forward';
  if (await onProtectedPage(tabId)) {
    // No debugger on this page: use the tabs API, which needs none.
    const nav = waitForNavigation(tabId, NAV_TIMEOUT_MS);
    try {
      await (delta < 0 ? chrome.tabs.goBack(tabId) : chrome.tabs.goForward(tabId));
    } catch (error) {
      nav.cancel();
      throw new Error(`Cannot go ${word}: ${errorMessage(error)}`);
    }
    await nav.promise;
    if (!(await onProtectedPage(tabId))) await ctx.cdp.ensure();
    await settle(ctx, tabId);
    return null;
  }
  const history = await ctx.cdp.send('Page.getNavigationHistory');
  const index = history.currentIndex + delta;
  if (index < 0) throw new Error('Cannot go back: there is no previous page in this tab\'s history');
  if (index >= history.entries.length) throw new Error('Cannot go forward: there is no next page in this tab\'s history');
  const entryUrl = history.entries[index].url || '';
  if (automationBlockReason(entryUrl)) {
    throw new Error(`Cannot go ${word}: the ${word === 'back' ? 'previous' : 'next'} page (${entryUrl.split(/[?#]/)[0]}) is protected by Chrome, the tab would drop out of Browser Control`);
  }
  const fileRefusal = /^file:/i.test(entryUrl) ? navigationBlockReason(entryUrl, navOptions(ctx)) : null;
  if (fileRefusal) throw new Error(`Cannot go ${word}: ${fileRefusal}`);
  const nav = waitForNavigation(tabId, NAV_TIMEOUT_MS);
  await ctx.cdp.send('Page.navigateToHistoryEntry', { entryId: history.entries[index].id });
  await nav.promise;
  await settle(ctx, tabId);
  return null;
}

/** @param {any} ctx */
export function navigationHandlers(ctx) {
  return {
    async browser_navigate({ url }) {
      const tabId = ctx.session.requireTab();
      const target = normalizeUrl(url);
      const refused = navigationBlockReason(target, navOptions(ctx));
      if (refused) throw new Error(`Refusing to open ${target.split(/[?#]/)[0].slice(0, 100)}: ${refused}.`);
      if (await onProtectedPage(tabId)) {
        // The tab was left on a protected page (by hand or by an older
        // version): bring it back without the debugger, then re-attach.
        const nav = waitForNavigation(tabId, NAV_TIMEOUT_MS);
        try {
          await chrome.tabs.update(tabId, { url: target });
        } catch (error) {
          nav.cancel();
          throw new Error(`Navigation to ${target} failed: ${errorMessage(error)}`);
        }
        await nav.promise;
        await ctx.cdp.ensure();
        await settle(ctx, tabId);
        return null;
      }
      const nav = waitForNavigation(tabId, NAV_TIMEOUT_MS);
      let result;
      try {
        result = await ctx.cdp.send('Page.navigate', { url: target });
      } catch (error) {
        nav.cancel();
        throw explainNavigateError(target, error);
      }
      if (result && result.errorText && result.errorText !== 'net::ERR_ABORTED') {
        nav.cancel();
        throw new Error(`Navigation to ${target} failed: ${result.errorText}`);
      }
      if (result && result.isDownload) {
        nav.cancel();
        return null;
      }
      await nav.promise;
      await settle(ctx, tabId);
      return null;
    },

    browser_go_back: () => historyStep(ctx, -1),
    browser_go_forward: () => historyStep(ctx, +1),

    /** server.py waits on its side; kept for completeness / direct clients. */
    async browser_wait({ time }) {
      const seconds = Number(time);
      if (!Number.isFinite(seconds) || seconds < 0 || seconds > 60) throw new Error('time must be between 0 and 60 seconds');
      await new Promise((r) => setTimeout(r, seconds * 1000));
      return null;
    },
  };
}

/** @param {any} ctx */
export function snapshotHandlers(ctx) {
  return {
    async getUrl() {
      const tab = await chrome.tabs.get(ctx.session.requireTab());
      return tab.url || tab.pendingUrl || '';
    },

    async getTitle() {
      const tab = await chrome.tabs.get(ctx.session.requireTab());
      return tab.title || '';
    },

    async browser_snapshot() {
      const tabId = ctx.session.requireTab();
      await waitTabReady(tabId, 10_000).catch(() => {});
      const generation = ctx.session.nextSnapshotGeneration();
      return ctx.agent.call(tabId, 'snapshot', { generation });
    },
  };
}
