// @ts-check
import { errorMessage, withTimeout } from '../shared/util.js';

const PROTOCOL_VERSION = '1.3';
const DEFAULT_TIMEOUT_MS = 20_000;

/** Domains always kept enabled while a tab is connected. */
export const CORE_DOMAINS = ['Page', 'Runtime', 'Log'];

const ENABLE_PARAMS = {
  Network: { maxTotalBufferSize: 20_000_000, maxResourceBufferSize: 5_000_000, maxPostDataSize: 65_536 },
};

/** @typedef {(params: any, method: string) => void} CdpListener */

/**
 * Owns the chrome.debugger attachment for the connected tab.
 *
 * Fixes of the donor's behaviour:
 *  - onDetach is tracked (reason + time), nothing fails silently;
 *  - the next command re-attaches and re-enables every wanted domain;
 *  - after a service-worker restart ("already attached"), Runtime/Log are
 *    disabled+enabled once, so V8 replays the console history.
 *
 * chrome.debugger listeners are registered by the service worker at top
 * level and forwarded to handleEvent / handleDetach.
 */
export class CdpSession {
  /** @param {{ api?: typeof chrome.debugger, now?: () => number }} [deps] */
  constructor(deps = {}) {
    this.api = deps.api || (globalThis.chrome && chrome.debugger);
    this.now = deps.now || Date.now;
    /** @type {number | null} */
    this.tabId = null;
    this.attached = false;
    this.attachedAt = 0;
    /** Increases on every (re-)attach; network bodies are only valid within one generation. */
    this.generation = 0;
    /** @type {Set<string>} */
    this.enabled = new Set();
    /** @type {Set<string>} */
    this.wanted = new Set(CORE_DOMAINS);
    /** @type {Record<string, string>} */
    this.enableErrors = {};
    /** @type {{reason: string, at: string} | null} */
    this.lastDetach = null;
    /** @type {{message: string, at: string} | null} */
    this.lastError = null;
    /**
     * Set when the user closed Chrome's debugging bar (Cancel or the close
     * cross, both arrive as canceled_by_user). Nothing re-attaches by itself
     * while it is set; the next real command does, and clears it.
     * @type {{at: string} | null}
     */
    this.pausedByUser = null;
    this.lastEventAt = 0;
    this.eventCount = 0;
    this.reattachCount = 0;
    /** @type {Promise<void> | null} */
    this.attaching = null;
    /** @type {Map<string, Set<CdpListener>>} method or 'Domain.*' or '*' */
    this.listeners = new Map();
    /** @type {Set<(reason: string) => void>} */
    this.detachListeners = new Set();
    /** @type {Set<(info: {generation: number, restored: boolean}) => void>} */
    this.attachListeners = new Set();
  }

  /** @param {number | null} tabId */
  setTab(tabId) {
    if (this.tabId === tabId) return;
    this.tabId = tabId;
    this.attached = false;
    this.pausedByUser = null;
    this.enabled.clear();
    this.enableErrors = {};
    this.wanted = new Set(CORE_DOMAINS);
  }

  /**
   * Subscribe to an event: exact method ('Runtime.consoleAPICalled'),
   * a whole domain ('Network.*') or everything ('*').
   * @param {string} key @param {CdpListener} fn
   * @returns {() => void} unsubscribe
   */
  on(key, fn) {
    let set = this.listeners.get(key);
    if (!set) this.listeners.set(key, (set = new Set()));
    set.add(fn);
    return () => set.delete(fn);
  }

  /** @param {(reason: string) => void} fn */
  onDetach(fn) {
    this.detachListeners.add(fn);
  }

  /** @param {(info: {generation: number, restored: boolean}) => void} fn */
  onAttach(fn) {
    this.attachListeners.add(fn);
  }

  /** chrome.debugger.onEvent forwarder. */
  handleEvent(source, method, params) {
    if (!source || source.tabId !== this.tabId || source.sessionId) return;
    this.lastEventAt = this.now();
    this.eventCount += 1;
    const domain = method.slice(0, method.indexOf('.'));
    for (const key of [method, `${domain}.*`, '*']) {
      const set = this.listeners.get(key);
      if (!set) continue;
      for (const fn of set) {
        try {
          fn(params || {}, method);
        } catch (error) {
          this.lastError = { message: `listener ${key}: ${errorMessage(error)}`, at: new Date(this.now()).toISOString() };
        }
      }
    }
  }

  /** chrome.debugger.onDetach forwarder. */
  handleDetach(source, reason) {
    if (!source || source.tabId !== this.tabId) return;
    this.attached = false;
    this.enabled.clear();
    this.lastDetach = { reason: String(reason), at: new Date(this.now()).toISOString() };
    if (String(reason) === 'canceled_by_user') this.pausedByUser = { at: this.lastDetach.at };
    for (const fn of this.detachListeners) {
      try {
        fn(String(reason));
      } catch {
        /* ignore */
      }
    }
  }

  requireTab() {
    if (this.tabId == null) throw new Error('No tab is connected');
    return this.tabId;
  }

  /** Attach (if needed) and enable every wanted domain. */
  async ensure() {
    this.requireTab();
    if (this.attached) return;
    if (!this.attaching) {
      this.attaching = this.attach().finally(() => {
        this.attaching = null;
      });
    }
    await this.attaching;
  }

  async attach() {
    const tabId = this.requireTab();
    let restored = false;
    try {
      await this.api.attach({ tabId }, PROTOCOL_VERSION);
    } catch (error) {
      const message = errorMessage(error);
      if (/already attached/i.test(message)) {
        // Our own attachment from before a service-worker restart, or another
        // extension. A probe below tells which.
        restored = true;
      } else {
        this.lastError = { message, at: new Date(this.now()).toISOString() };
        const hint = /cannot access/i.test(message)
          ? '. The tab shows a page Chrome protects from extensions; call browser_navigate with a regular http(s) URL (it works without the debugger) or go back in the tab by hand.'
          : '';
        throw new Error(`Cannot attach the debugger to the tab: ${message}${hint}`);
      }
    }
    this.attached = true;
    this.pausedByUser = null;
    this.attachedAt = this.now();
    this.generation += 1;
    if (this.lastDetach) this.reattachCount += 1;
    this.enabled.clear();
    this.enableErrors = {};
    if (restored) {
      try {
        await this.raw('Runtime.evaluate', { expression: '1', returnByValue: true }, 5000);
      } catch (error) {
        this.attached = false;
        const message = errorMessage(error);
        this.lastError = { message, at: new Date(this.now()).toISOString() };
        throw new Error(
          `Another debugger client (probably another extension such as Browser MCP) owns this tab: ${message}. Disable it in chrome://extensions and reconnect.`,
        );
      }
      // Force V8/Log to replay their stored history into our fresh buffers.
      for (const domain of ['Runtime', 'Log']) {
        await this.raw(`${domain}.disable`, {}, 5000).catch(() => {});
      }
    }
    for (const domain of this.wanted) await this.enable(domain);
    for (const fn of this.attachListeners) {
      try {
        fn({ generation: this.generation, restored });
      } catch {
        /* ignore */
      }
    }
  }

  /** @param {string} domain */
  async enable(domain) {
    try {
      await this.raw(`${domain}.enable`, ENABLE_PARAMS[domain] || {}, 10_000);
      this.enabled.add(domain);
      delete this.enableErrors[domain];
    } catch (error) {
      this.enableErrors[domain] = errorMessage(error);
    }
  }

  /** Keep a domain enabled from now on, including after re-attach. @param {string} domain */
  async want(domain) {
    this.wanted.add(domain);
    await this.ensure();
    if (!this.enabled.has(domain)) await this.enable(domain);
    if (!this.enabled.has(domain)) throw new Error(`${domain}.enable failed: ${this.enableErrors[domain]}`);
  }

  /** @param {string} domain */
  async unwant(domain) {
    if (CORE_DOMAINS.includes(domain)) return;
    this.wanted.delete(domain);
    if (this.attached && this.enabled.has(domain)) {
      await this.raw(`${domain}.disable`, {}, 10_000).catch(() => {});
    }
    this.enabled.delete(domain);
  }

  /** sendCommand without ensure(). */
  async raw(method, params = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const tabId = this.requireTab();
    return withTimeout(
      Promise.resolve(this.api.sendCommand({ tabId }, method, params)),
      timeoutMs,
      `CDP ${method} did not answer within ${Math.round(timeoutMs / 1000)}s`,
    );
  }

  /**
   * Send a CDP command to the connected tab, attaching first if needed.
   * One transparent retry when the debugger turned out to be detached.
   * @param {string} method @param {object} [params] @param {number} [timeoutMs]
   */
  async send(method, params = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
    await this.ensure();
    try {
      return await this.raw(method, params, timeoutMs);
    } catch (error) {
      const message = errorMessage(error);
      if (/not attached|detached/i.test(message)) {
        this.attached = false;
        this.enabled.clear();
        await this.ensure();
        return await this.raw(method, params, timeoutMs);
      }
      throw new Error(`${method}: ${message}`);
    }
  }

  async detach() {
    const tabId = this.tabId;
    const wasAttached = this.attached;
    this.attached = false;
    this.enabled.clear();
    if (tabId != null && wasAttached) {
      await Promise.resolve(this.api.detach({ tabId })).catch(() => {});
    }
  }

  status() {
    return {
      tabId: this.tabId,
      attached: this.attached,
      attachedAt: this.attachedAt ? new Date(this.attachedAt).toISOString() : null,
      generation: this.generation,
      domains: [...this.enabled],
      wanted: [...this.wanted],
      enableErrors: this.enableErrors,
      lastDetach: this.lastDetach,
      pausedByUser: this.pausedByUser,
      lastError: this.lastError,
      reattachCount: this.reattachCount,
      events: this.eventCount,
      lastEventAt: this.lastEventAt ? new Date(this.lastEventAt).toISOString() : null,
    };
  }
}
