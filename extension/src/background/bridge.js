// @ts-check
import { errorMessage } from '../shared/util.js';

const KEEPALIVE_MS = 20_000; // < 30 s so the MV3 service worker stays alive
const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 10_000;

/** @typedef {'idle' | 'connecting' | 'open' | 'closed'} LinkStatus */

/**
 * WebSocket client to server.py (ws://localhost:9009 by default).
 * The server is the WebSocket server; it keeps only the newest connection.
 */
export class Bridge {
  /**
   * @param {{
   *   url: () => string,
   *   onRequest: (message: any) => Promise<object>,
   *   onStatus?: (status: LinkStatus) => void,
   *   onClose?: (code: number, reason: string) => void,
   *   WebSocketImpl?: typeof WebSocket,
   *   keepaliveMs?: number,
   * }} options
   */
  constructor(options) {
    this.options = options;
    this.WebSocketImpl = options.WebSocketImpl || globalThis.WebSocket;
    /** @type {WebSocket | null} */
    this.ws = null;
    /** @type {LinkStatus} */
    this.status = 'idle';
    this.wanted = false;
    this.attempts = 0;
    this.reconnects = 0;
    this.openedAt = 0;
    this.closedAt = 0;
    /** @type {string | null} */
    this.lastError = null;
    /** @type {{code: number, reason: string, at: number} | null} */
    this.lastClose = null;
    this.received = 0;
    this.sent = 0;
    /** @type {ReturnType<typeof setTimeout> | null} */
    this.retryTimer = null;
    /** @type {ReturnType<typeof setInterval> | null} */
    this.keepaliveTimer = null;
  }

  /** @param {LinkStatus} status */
  setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this.options.onStatus?.(status);
  }

  start() {
    this.wanted = true;
    this.connect();
  }

  stop() {
    this.wanted = false;
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.close(1000, 'disconnected by user');
      } catch {
        /* already closed */
      }
    }
    this.attempts = 0;
    this.setStatus('idle');
  }

  /** Reconnect now (e.g. after the port changed). */
  restart() {
    const wanted = this.wanted;
    this.stop();
    if (wanted) this.start();
  }

  isOpen() {
    return !!this.ws && this.ws.readyState === 1;
  }

  connect() {
    if (!this.wanted) return;
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    const url = this.options.url();
    this.setStatus('connecting');
    let ws;
    try {
      ws = new this.WebSocketImpl(url);
    } catch (error) {
      this.lastError = errorMessage(error);
      this.scheduleRetry();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      if (this.openedAt) this.reconnects += 1;
      this.attempts = 0;
      this.openedAt = Date.now();
      this.lastError = null;
      this.setStatus('open');
      this.keepaliveTimer = setInterval(
        () => this.send({ type: 'keepalive', payload: { ts: Date.now() } }),
        this.options.keepaliveMs || KEEPALIVE_MS,
      );
    };
    ws.onmessage = (event) => {
      if (this.ws !== ws) return;
      this.received += 1;
      this.handleMessage(event.data);
    };
    ws.onerror = () => {
      this.lastError = `WebSocket error talking to ${url}`;
    };
    ws.onclose = (event) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.closedAt = Date.now();
      this.lastClose = { code: event.code, reason: event.reason || '', at: this.closedAt };
      if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
      this.setStatus(this.wanted ? 'closed' : 'idle');
      // lets the worker drop a launch token the server refused (4403)
      // before the retry, so the next attempt goes out without it.
      try {
        this.options.onClose?.(event.code, event.reason || '');
      } catch {
        /* a hook must not break reconnects */
      }
      this.scheduleRetry();
    };
  }

  scheduleRetry() {
    if (!this.wanted || this.retryTimer) return;
    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** this.attempts);
    this.attempts += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }

  clearTimers() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.retryTimer = null;
    this.keepaliveTimer = null;
  }

  /** @param {unknown} raw */
  async handleMessage(raw) {
    let message;
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!message || typeof message !== 'object' || typeof message.type !== 'string') return;
    if (message.id === undefined || message.id === null) return; // not a request
    const response = await this.options.onRequest(message);
    this.send(response);
  }

  /** @param {object} message */
  send(message) {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) return false;
    try {
      ws.send(JSON.stringify(message));
      this.sent += 1;
      return true;
    } catch (error) {
      this.lastError = errorMessage(error);
      return false;
    }
  }

  info() {
    return {
      status: this.status,
      // the agent-session token is not shown in diagnostics.
      url: this.options.url().replace(/([?&]launch=)[^&]+/, '$1***'),
      wanted: this.wanted,
      openedAt: this.openedAt ? new Date(this.openedAt).toISOString() : null,
      reconnects: this.reconnects,
      retryAttempt: this.attempts,
      received: this.received,
      sent: this.sent,
      lastError: this.lastError,
      lastClose: this.lastClose,
    };
  }
}
