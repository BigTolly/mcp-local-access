// @ts-check
import { errorMessage } from '../shared/util.js';

const STORAGE_KEY = 'bcSession';

const BLOCKED_URL = /^(chrome|chrome-extension|chrome-untrusted|devtools|edge|about|view-source|chrome-search):/i;
const WEB_STORE = /^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com)/i;

/** @param {string | undefined} url */
export function automationBlockReason(url) {
  if (!url) return null;
  if (url === 'about:blank') return null;
  if (BLOCKED_URL.test(url)) return `Chrome does not allow extensions to control ${url.split(/[?#]/)[0]}. Open a regular website in this tab and connect again.`;
  if (WEB_STORE.test(url)) return 'Chrome does not allow extensions to control the Chrome Web Store. Open another website and connect again.';
  return null;
}

/**
 * Which tab is connected, plus Connect / Disconnect / restore after a
 * service-worker restart. The WebSocket link is open exactly while a tab is
 * connected: that is how server.py knows whether a tab is available.
 */
export class Session {
  /**
   * @param {{
   *   cdp: import('./cdp.js').CdpSession,
   *   bridge: import('./bridge.js').Bridge,
   *   onChange: () => void,
   *   onConnectTab: (tabId: number, restored: boolean) => void,
   *   onDisconnectTab: (tabId: number, reason: string) => void,
   * }} deps
   */
  constructor(deps) {
    this.deps = deps;
    /** @type {number | null} */
    this.tabId = null;
    this.connectedAt = 0;
    this.snapshotGeneration = 0;
    /** @type {string | null} */
    this.lastError = null;
    /** @type {{reason: string, at: string} | null} */
    this.lastDisconnect = null;
  }

  requireTab() {
    if (this.tabId == null) throw new Error('No tab is connected');
    return this.tabId;
  }

  record() {
    return { tabId: this.tabId, gen: this.snapshotGeneration, at: this.connectedAt, paused: this.deps.cdp.pausedByUser || null };
  }

  async persist() {
    if (this.tabId == null) await chrome.storage.session.remove(STORAGE_KEY);
    else await chrome.storage.session.set({ [STORAGE_KEY]: this.record() });
  }

  nextSnapshotGeneration() {
    this.snapshotGeneration += 1;
    chrome.storage.session.set({ [STORAGE_KEY]: this.record() }).catch(() => {});
    return this.snapshotGeneration;
  }

  /**
   * @param {number} tabId
   * @param {{ restored?: boolean, paused?: {at: string} | null }} [options]
   *   paused: restore a tab whose debugger the user had paused (Chrome bar
   *   closed) without attaching, so the bar does not pop back by itself.
   */
  async connect(tabId, options = {}) {
    const tab = await chrome.tabs.get(tabId);
    const blocked = automationBlockReason(tab.url || tab.pendingUrl);
    // A service-worker restart while the tab sits on chrome://... used to drop
    // the session for good. Restore it without the debugger instead:
    // browser_navigate/go_back work through chrome.tabs, and the debugger
    // re-attaches by itself once the tab shows a regular page.
    if (blocked && !options.restored) throw new Error(blocked);
    if (this.tabId === tabId && this.deps.bridge.wanted) {
      await this.deps.cdp.ensure();
      return;
    }
    if (this.tabId != null && this.tabId !== tabId) await this.disconnect('switched to another tab');
    this.tabId = tabId;
    this.connectedAt = Date.now();
    this.deps.cdp.setTab(tabId);
    this.deps.onConnectTab(tabId, !!options.restored);
    try {
      if (options.paused) this.deps.cdp.pausedByUser = options.paused;
      else if (!blocked) await this.deps.cdp.ensure();
    } catch (error) {
      this.lastError = errorMessage(error);
      this.tabId = null;
      this.deps.cdp.setTab(null);
      await this.persist();
      this.deps.onChange();
      throw error;
    }
    this.lastError = null;
    await this.persist();
    this.deps.bridge.start();
    this.deps.onChange();
  }

  /** @param {string} reason */
  async disconnect(reason = 'disconnected by user') {
    const tabId = this.tabId;
    this.deps.bridge.stop();
    if (tabId != null) {
      await this.deps.cdp.detach();
      this.deps.onDisconnectTab(tabId, reason);
    }
    this.deps.cdp.setTab(null);
    this.tabId = null;
    this.lastDisconnect = { reason, at: new Date().toISOString() };
    await this.persist();
    this.deps.onChange();
  }

  /** After a service-worker restart: reconnect the tab saved in storage.session. */
  async restore() {
    const saved = (await chrome.storage.session.get(STORAGE_KEY))[STORAGE_KEY];
    if (!saved || typeof saved.tabId !== 'number') return false;
    this.snapshotGeneration = Number(saved.gen) || 0;
    try {
      await this.connect(saved.tabId, { restored: true, paused: saved.paused && saved.paused.at ? saved.paused : null });
      return true;
    } catch (error) {
      this.lastError = `restore failed: ${errorMessage(error)}`;
      await chrome.storage.session.remove(STORAGE_KEY);
      return false;
    }
  }

  info() {
    return {
      tabId: this.tabId,
      connectedAt: this.connectedAt && this.tabId != null ? new Date(this.connectedAt).toISOString() : null,
      snapshotGeneration: this.snapshotGeneration,
      lastError: this.lastError,
      lastDisconnect: this.lastDisconnect,
    };
  }
}
