// @ts-check
// Browser Control service worker: wires the bridge, the debugger session,
// the stores and the tool handlers. All chrome.* listeners are registered
// synchronously at top level, as MV3 requires.

import { Bridge } from './bridge.js';
import { Router } from './router.js';
import { CdpSession } from './cdp.js';
import { Session, automationBlockReason } from './session.js';
import { PageAgent } from './page-agent.js';
import { IconController } from './icon.js';
import { ensureThemeProbe, queryTheme } from './theme.js';
import { ConsoleStore } from '../shared/console-store.js';
import { NetworkStore } from '../shared/network-store.js';
import { errorMessage, VERSION } from '../shared/util.js';
import { CdpEventStore, devtoolsHandlers } from '../tools/devtools.js';
import { navigationHandlers, snapshotHandlers } from '../tools/navigation.js';
import { inputHandlers } from '../tools/input.js';
import { captureHandlers } from '../tools/capture.js';
import { consoleHandlers, captureHealth } from '../tools/console.js';
import { networkHandlers } from '../tools/network.js';
import { diagnosticsHandlers } from '../tools/diagnostics.js';
import { parseLaunchUrl, bridgeUrl, probeLaunch, CLOSE_BAD_TOKEN, CLOSE_AGENT_BUSY } from './launch.js';

const SETTINGS_KEY = 'bcSettings';
/**
 * barCancel: what Cancel / the close cross on Chrome's debugging bar does.
 *  'pause'      - only the debugger lets go; the tab stays connected and the
 *                 next command re-attaches (Chrome shows the bar again then).
 *  'disconnect' - full Disconnect.
 * Chrome reports both buttons as the same canceled_by_user, so they cannot
 * be told apart.
 */
/**
 * allowFileUrls: let browser_navigate / browser_cdp open file:// pages
 * (off by default: with Chrome's "Allow access to file URLs" on, file:// shows
 * the AI the whole disk, outside the Local Access folder and its rules).
 */
const DEFAULT_SETTINGS = { host: 'localhost', port: 9009, barCancel: 'pause', allowFileUrls: false };
let settings = { ...DEFAULT_SETTINGS };

/**
 * Agent browser session, started by server.py browser_launch.
 * Kept in storage.session so a worker restart reconnects with the same token.
 * @type {{ token: string, tabId: number, at: number } | null}
 */
let launch = null;
const LAUNCH_KEY = 'bcLaunch';
/** @type {Set<string>} tokens being probed right now */
const launchInFlight = new Set();
/** @type {string | null} */
let launchNote = null;

const startedAt = Date.now();
const consoleStore = new ConsoleStore(1000);
const networkStore = new NetworkStore(300);
const cdpEvents = new CdpEventStore(1000);
const cdp = new CdpSession();
const agent = new PageAgent();
const icons = new IconController();

/** @type {Router} */
let router; // assigned below, used lazily by the bridge

const bridge = new Bridge({
  url: () => bridgeUrl(settings.host, settings.port, launch && launch.token),
  onRequest: (message) => router.handle(message),
  onStatus: () => refreshIcons(),
  onClose: (code) => {
    if (code === CLOSE_BAD_TOKEN && launch) {
      // The server no longer knows this agent session (restarted, or closed it).
      launchNote = 'launch token refused by the server: agent session dropped';
      clearLaunch().catch(() => {});
    } else if (code === CLOSE_AGENT_BUSY) {
      launchNote = 'an agent browser session (browser_launch) owns the server bridge; retrying';
    }
  },
});

const session = new Session({
  cdp,
  bridge,
  onChange: () => refreshIcons(),
  onConnectTab: (tabId, restored) => {
    if (!restored) {
      consoleStore.reset();
      networkStore.stop();
      networkStore.clear();
      cdpEvents.subscribed.clear();
      cdpEvents.enabledByUs.clear();
      cdpEvents.buffer.clear();
    }
    consoleStore.mark('diagnostic', `${restored ? 'Capture restored after service-worker restart' : 'Capture started'} for tab ${tabId}`);
  },
  onDisconnectTab: (tabId, reason) => {
    consoleStore.mark('diagnostic', `Tab ${tabId} disconnected: ${reason}`);
    networkStore.stop();
  },
});

const ctx = { session, cdp, agent, bridge, consoleStore, networkStore, cdpEvents, startedAt, version: VERSION, getSettings: () => settings, router: /** @type {any} */ (null) };

router = new Router({
  ...snapshotHandlers(ctx),
  ...navigationHandlers(ctx),
  ...inputHandlers(ctx),
  ...captureHandlers(ctx),
  ...consoleHandlers(ctx),
  ...networkHandlers(ctx),
  ...diagnosticsHandlers(ctx),
  ...devtoolsHandlers(ctx),
  ...launchHandlers(),
});
ctx.router = router;

// ------------------------------------------------------------ agent session ---

async function clearLaunch() {
  launch = null;
  await chrome.storage.session.remove(LAUNCH_KEY);
}

/**
 * A tab opened on the server's launch page: check the token with the server
 * first (a web page can open that URL too), then connect the tab as if the
 * user had pressed Connect. server.py navigates it to the real site after.
 * @param {number} tabId @param {string} url
 */
async function onLaunchTab(tabId, url) {
  const parsed = parseLaunchUrl(url);
  if (!parsed) return;
  if (launch && launch.token === parsed.token && session.tabId === tabId) return;
  if (launchInFlight.has(parsed.token)) return;
  launchInFlight.add(parsed.token);
  try {
    await ready; // settings (port) and the restored session first
    if (parsed.port !== settings.port) {
      throw new Error(`launch page is on port ${parsed.port}, the extension uses ${settings.port}`);
    }
    const accepted = await probeLaunch(bridgeUrl(settings.host, settings.port, parsed.token, true));
    if (!accepted) throw new Error('the server did not accept the launch token');
    // Reconnect the link with the token: a plain link would be refused now.
    if (session.tabId != null) await session.disconnect('an agent browser session started');
    launch = { token: parsed.token, tabId, at: Date.now() };
    await chrome.storage.session.set({ [LAUNCH_KEY]: launch });
    await session.connect(tabId);
    launchNote = null;
    consoleStore.mark('diagnostic', `Agent browser session: tab ${tabId} connected by browser_launch`);
  } catch (error) {
    launchNote = `agent launch ignored: ${errorMessage(error)}`;
  } finally {
    launchInFlight.delete(parsed.token);
  }
}

function launchHandlers() {
  return {
    /** Close the agent's tab (only in an agent session). Answers first, closes right after. */
    browser_close_tab: async () => {
      if (!launch) throw new Error('browser_close_tab only closes the tab of an agent browser session (browser_launch)');
      const tabId = session.requireTab();
      const others = (await chrome.tabs.query({})).filter((t) => t.id !== tabId);
      setTimeout(() => {
        clearLaunch().catch(() => {});
        chrome.tabs.remove(tabId).catch(() => session.disconnect('closed by the agent').catch(() => {}));
      }, 200);
      return {
        closedTabId: tabId,
        remainingTabs: others.length,
        remainingWindows: new Set(others.map((t) => t.windowId)).size,
      };
    },
  };
}

function refreshIcons() {
  icons
    .refresh({ tabId: session.tabId, linkOpen: bridge.isOpen(), waiting: bridge.wanted && !bridge.isOpen(), paused: !!cdp.pausedByUser })
    .catch(() => {});
}

// ------------------------------------------------------------ CDP events ---

cdp.on('Runtime.consoleAPICalled', (p) => consoleStore.onConsoleApi(p));
cdp.on('Runtime.exceptionThrown', (p) => consoleStore.onException(p));
cdp.on('Log.entryAdded', (p) => consoleStore.onLogEntry(p));
cdp.on('Page.frameNavigated', (p) => {
  if (p.frame && !p.frame.parentId) consoleStore.mark('navigation', `Navigated to ${p.frame.url}${p.frame.urlFragment || ''}`, p.frame.url);
});
cdp.on('Network.requestWillBeSent', (p) => networkStore.onRequestWillBeSent(p, cdp.generation));
cdp.on('Network.responseReceived', (p) => networkStore.onResponseReceived(p));
cdp.on('Network.loadingFinished', (p) => networkStore.onLoadingFinished(p));
cdp.on('Network.loadingFailed', (p) => networkStore.onLoadingFailed(p));
cdp.on('*', (p, method) => cdpEvents.onEvent(method, p));

cdp.onDetach((reason) => {
  consoleStore.mark('diagnostic', `Debugger detached: ${reason}. Events may be missing until it re-attaches.`);
  if (reason === 'canceled_by_user') {
    // Cancel or the close cross on Chrome's debugging bar (same event).
    if (settings.barCancel === 'disconnect') {
      session.disconnect('debugging canceled by the user in Chrome').catch(() => {});
    } else {
      // Pause: no automatic re-attach (that would bring the bar right back);
      // the next command re-attaches and Chrome replays the console history.
      consoleStore.mark('diagnostic', 'Chrome debugging bar closed by the user: debugger paused, the tab stays connected and re-attaches on the next command');
      session.persist().catch(() => {});
      refreshIcons();
    }
    return;
  }
  const tabId = session.tabId;
  if (tabId == null) return;
  setTimeout(() => {
    if (session.tabId !== tabId) return;
    chrome.tabs
      .get(tabId)
      .then(() => cdp.ensure())
      .then(() => consoleStore.mark('diagnostic', 'Debugger re-attached'))
      .catch(() => {});
  }, 1000);
});

cdp.onAttach(({ restored }) => {
  if (cdp.reattachCount > 0 || restored) consoleStore.mark('diagnostic', `Debugger attached (generation ${cdp.generation}); Runtime/Log history replayed by Chrome`);
  if (session.tabId != null) session.persist().catch(() => {}); // drops a stored pause
  refreshIcons();
});

chrome.debugger.onEvent.addListener((source, method, params) => cdp.handleEvent(source, method, params));
chrome.debugger.onDetach.addListener((source, reason) => cdp.handleDetach(source, reason));

// ------------------------------------------------------------ tabs ---

chrome.tabs.onRemoved.addListener((tabId) => {
  icons.forget(tabId);
  if (launch && tabId === launch.tabId) clearLaunch().catch(() => {});
  if (tabId === session.tabId) session.disconnect('the tab was closed').catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  const seenUrl = info.url || (info.status === 'loading' && tab ? tab.url || tab.pendingUrl : undefined);
  if (seenUrl && parseLaunchUrl(seenUrl)) {
    onLaunchTab(tabId, seenUrl).catch(() => {});
    return;
  }
  if (tabId !== session.tabId) return;
  if (info.status === 'loading' || info.status === 'complete') refreshIcons();
  // Without the debugger there is no Page.frameNavigated: still mark where
  // the tab went, so the journal shows the gap.
  if (info.url && !cdp.attached) {
    consoleStore.mark('navigation', `Navigated to ${info.url} (debugger not attached: page events are not captured here)`, info.url);
  }
  // Back from a page Chrome protects (chrome://..., Web Store): the debugger
  // was kicked out there, take the tab back as soon as it loads a normal page
  // so early console errors are not missed. Not while paused by the user.
  if (info.status === 'loading' && !cdp.attached && !cdp.attaching && !cdp.pausedByUser && tab && !automationBlockReason(tab.url || tab.pendingUrl)) {
    cdp
      .ensure()
      .then(() => consoleStore.mark('diagnostic', 'Debugger re-attached after leaving a protected page'))
      .catch(() => {});
  }
});

chrome.tabs.onReplaced.addListener((added, removed) => {
  if (removed === session.tabId) {
    session.disconnect('the tab was replaced by Chrome').then(() => session.connect(added)).catch(() => {});
  }
});

// ------------------------------------------------------------ messages ---

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== 'object') return false;
  if (message.type === 'bc-theme') {
    setTheme(message.dark ? 'dark' : 'light');
    return false;
  }
  if (message.type !== 'bc-popup') return false;
  handlePopup(message)
    .then((value) => sendResponse({ ok: true, value }))
    .catch((error) => sendResponse({ ok: false, error: errorMessage(error) }));
  return true; // async response
});

async function popupState() {
  const tab = session.tabId != null ? await chrome.tabs.get(session.tabId).catch(() => null) : null;
  return {
    version: VERSION,
    settings,
    bridge: bridge.info(),
    tab: tab ? { id: tab.id, title: tab.title, url: tab.url } : null,
    session: session.info(),
    debugger: { attached: cdp.attached, domains: [...cdp.enabled], lastDetach: cdp.lastDetach, pausedByUser: cdp.pausedByUser },
    theme: icons.theme,
    agentSession: launch ? { tabId: launch.tabId, since: new Date(launch.at).toISOString() } : null,
    agentNote: launchNote,
  };
}

/** @param {any} message */
async function handlePopup(message) {
  switch (message.cmd) {
    case 'state':
      return popupState();
    case 'connect':
      await session.connect(Number(message.tabId));
      return popupState();
    case 'disconnect':
      await session.disconnect('disconnected from the popup');
      return popupState();
    case 'setBarCancel': {
      const value = message.value === 'disconnect' ? 'disconnect' : 'pause';
      settings = { ...settings, barCancel: value };
      await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
      return popupState();
    }
    case 'setAllowFile': {
      settings = { ...settings, allowFileUrls: !!message.value };
      await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
      return popupState();
    }
    case 'setPort': {
      const port = Number(message.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be 1..65535');
      settings = { ...settings, port };
      await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
      bridge.restart();
      return popupState();
    }
    case 'theme':
      setTheme(message.dark ? 'dark' : 'light');
      return popupState();
    case 'diagnostics': {
      const health = await captureHealth(ctx);
      const diag = await router.execute('browser_diagnostics', {});
      return { health, diagnostics: diag.ok ? diag.result : diag.error };
    }
    default:
      throw new Error(`Unknown popup command ${message.cmd}`);
  }
}

/** @param {'light' | 'dark'} theme */
function setTheme(theme) {
  if (icons.theme === theme) return;
  icons.theme = theme;
  chrome.storage.local.set({ bcTheme: theme }).catch(() => {});
  refreshIcons();
}

// ------------------------------------------------------------ keep alive ---

chrome.alarms.create('bc-keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'bc-keepalive') return;
  if (session.tabId != null && !bridge.isOpen()) bridge.connect();
  ensureThemeProbe().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  /* init() below runs on every worker start */
});
chrome.runtime.onInstalled.addListener(() => {
  /* init() below runs on every worker start */
});

// ------------------------------------------------------------ init ---

async function init() {
  const stored = await chrome.storage.local.get([SETTINGS_KEY, 'bcTheme']);
  settings = { ...DEFAULT_SETTINGS, ...(stored[SETTINGS_KEY] || {}) };
  const savedLaunch = (await chrome.storage.session.get(LAUNCH_KEY))[LAUNCH_KEY];
  if (savedLaunch && typeof savedLaunch.token === 'string' && typeof savedLaunch.tabId === 'number') launch = savedLaunch;
  if (stored.bcTheme === 'dark' || stored.bcTheme === 'light') icons.theme = stored.bcTheme;
  refreshIcons();
  await ensureThemeProbe();
  const theme = await queryTheme();
  if (theme) setTheme(theme);
  await session.restore();
  refreshIcons();
  // A launch page may have loaded before the worker woke up.
  for (const tab of await chrome.tabs.query({})) {
    const url = tab.url || tab.pendingUrl;
    if (tab.id != null && parseLaunchUrl(url)) onLaunchTab(tab.id, String(url)).catch(() => {});
  }
}

const ready = init().catch((error) => {
  console.error('Browser Control init failed:', error);
});
