// @ts-check
import { errorMessage, VERSION } from '../shared/util.js';

/** @param {any} ctx */
export function diagnosticsHandlers(ctx) {
  return {
    async browser_diagnostics() {
      const tabId = ctx.session.tabId;
      const tab = tabId != null ? await chrome.tabs.get(tabId).catch(() => null) : null;
      /** @type {{ok: boolean, ms?: number, error?: string} | null} */
      let probe = null;
      if (tabId != null) {
        const started = Date.now();
        try {
          // A real CDP round trip, not just "the WebSocket is up".
          await ctx.cdp.send('Runtime.evaluate', { expression: '1', returnByValue: true }, 4000);
          probe = { ok: true, ms: Date.now() - started };
        } catch (error) {
          probe = { ok: false, ms: Date.now() - started, error: errorMessage(error) };
        }
      }
      const cdp = ctx.cdp.status();
      const debuggerReady = !!(probe && probe.ok && cdp.domains.includes('Runtime') && cdp.domains.includes('Log'));
      return {
        extension: 'Browser Control',
        version: VERSION,
        chrome: (navigator.userAgent.match(/Chrome\/([\d.]+)/) || [])[1] || null,
        workerStartedAt: new Date(ctx.startedAt).toISOString(),
        uptimeSec: Math.round((Date.now() - ctx.startedAt) / 1000),
        bridge: ctx.bridge.info(),
        session: ctx.session.info(),
        tab: tab ? { id: tab.id, url: tab.url, title: tab.title, status: tab.status, active: tab.active, windowId: tab.windowId } : null,
        debuggerReady,
        probe,
        debugger: cdp,
        console: ctx.consoleStore.stats(),
        network: ctx.networkStore.stats(),
        cdpEvents: ctx.cdpEvents.stats(),
        recentCommands: ctx.router ? ctx.router.recent(10) : [],
      };
    },
  };
}
