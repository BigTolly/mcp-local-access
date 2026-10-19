// @ts-check
import { CONSOLE_LEVELS } from '../shared/console-store.js';
import { errorMessage, intInRange, VERSION } from '../shared/util.js';

/**
 * Check that capture is really live before answering: an empty journal
 * must never hide a dead debugger (the donor's main bug).
 * @param {any} ctx
 */
export async function captureHealth(ctx) {
  if (ctx.session.tabId == null) return { healthy: false, error: 'No tab is connected' };
  try {
    await ctx.cdp.ensure();
  } catch (error) {
    return { healthy: false, error: errorMessage(error) };
  }
  const domains = ctx.cdp.enabled;
  const missing = ['Runtime', 'Log'].filter((d) => !domains.has(d));
  if (missing.length) {
    return { healthy: false, error: `Not subscribed to ${missing.join(', ')}: ${missing.map((d) => ctx.cdp.enableErrors[d] || 'unknown error').join('; ')}` };
  }
  return { healthy: true, error: null };
}

/** @param {any} ctx */
export function consoleHandlers(ctx) {
  return {
    async browser_console({ limit = 100, level = 'all', clear = false }) {
      const max = intInRange(limit, 1, 500, 'limit');
      if (!CONSOLE_LEVELS.includes(level)) throw new Error(`level must be one of ${CONSOLE_LEVELS.join(', ')}`);
      const health = await captureHealth(ctx);
      const result = ctx.consoleStore.query({ limit: max, level });
      if (clear) ctx.consoleStore.clear();
      const tab = ctx.session.tabId != null ? await chrome.tabs.get(ctx.session.tabId).catch(() => null) : null;
      return {
        version: VERSION,
        healthy: health.healthy,
        error: health.error,
        tab: tab ? { id: tab.id, url: tab.url, title: tab.title } : null,
        level,
        cleared: !!clear,
        ...result,
        lastDetach: ctx.cdp.lastDetach,
        note: 'Captured since Connect (plus history Chrome replays on attach). Buffers live in memory: a browser restart loses them.',
      };
    },

    /** Legacy tool: plain list, but a dead capture is reported, not hidden. */
    async browser_get_console_logs() {
      const health = await captureHealth(ctx);
      const logs = ctx.consoleStore.query({ limit: 500, level: 'all' }).logs.map((e) => ({
        type: e.level,
        timestamp: e.time,
        message: e.text,
        ...(e.url ? { url: e.url, line: e.line } : {}),
        ...(e.stack ? { stack: e.stack } : {}),
      }));
      if (!health.healthy) {
        logs.unshift({ type: 'diagnostic', timestamp: new Date().toISOString(), message: `Console capture is NOT active: ${health.error}` });
      }
      return logs;
    },
  };
}
