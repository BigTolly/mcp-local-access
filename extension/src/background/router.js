// @ts-check
import { RingBuffer } from '../shared/ring-buffer.js';
import { errorMessage, truncate } from '../shared/util.js';

/** Commands that only read state: they never wait behind a running action. */
export const PARALLEL_SAFE = new Set([
  'getUrl',
  'getTitle',
  'browser_diagnostics',
  'browser_console',
  'browser_get_console_logs',
  'browser_network',
  'browser_cdp_events',
]);

/**
 * Reads run in parallel, but some actions of these commands attach the
 * debugger or enable domains. Those go through the action queue.
 * @param {string} type @param {any} payload
 */
export function isParallelSafe(type, payload) {
  if (!PARALLEL_SAFE.has(type)) return false;
  const action = payload && typeof payload === 'object' ? payload.action : undefined;
  if (type === 'browser_cdp_events') return action !== 'subscribe' && action !== 'unsubscribe';
  if (type === 'browser_network') return action !== 'start' && action !== 'stop';
  return true;
}

/** @typedef {(payload: any) => Promise<any> | any} Handler */

/**
 * Maps a server request {id, type, payload} to a handler and builds the
 * messageResponse expected by server.py. Actions run one at a time.
 */
export class Router {
  /** @param {Record<string, Handler>} handlers */
  constructor(handlers) {
    this.handlers = handlers;
    /** @type {RingBuffer<{type: string, ok: boolean, ms: number, at: string, error?: string}>} */
    this.log = new RingBuffer(50);
    /** @type {Promise<unknown>} */
    this.queue = Promise.resolve();
    this.busy = 0;
  }

  /**
   * @param {{id: string | number, type: string, payload?: any}} message
   */
  async handle(message) {
    const { id, type } = message;
    const payload = message.payload ?? {};
    const run = () => this.execute(type, payload);
    let outcome;
    if (isParallelSafe(type, payload)) {
      outcome = await run();
    } else {
      const next = this.queue.then(run, run);
      this.queue = next.catch(() => {});
      outcome = await next;
    }
    if (outcome.ok) {
      return { type: 'messageResponse', payload: { requestId: id, result: outcome.result === undefined ? null : outcome.result } };
    }
    return { type: 'messageResponse', payload: { requestId: id, error: outcome.error } };
  }

  /** @param {string} type @param {any} payload */
  async execute(type, payload) {
    const started = Date.now();
    this.busy += 1;
    try {
      const handler = Object.prototype.hasOwnProperty.call(this.handlers, type) ? this.handlers[type] : undefined;
      if (!handler) throw new Error(`Unknown command: ${type}`);
      const result = await handler(payload);
      this.log.push({ type, ok: true, ms: Date.now() - started, at: new Date(started).toISOString() });
      return { ok: true, result };
    } catch (error) {
      const text = errorMessage(error) || 'Unknown error';
      this.log.push({ type, ok: false, ms: Date.now() - started, at: new Date(started).toISOString(), error: truncate(text, 300) });
      return { ok: false, error: text };
    } finally {
      this.busy -= 1;
    }
  }

  /** @param {number} n */
  recent(n) {
    return this.log.last(n);
  }
}
