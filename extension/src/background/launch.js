// @ts-check
// Agent browser session: server.py's browser_launch starts Chrome on
// http://<host>:<port>/bc-launch#<token>. The extension spots that tab, asks
// the server whether the token is live (probe connection) and only then
// connects the tab, so no Connect click is needed. No chrome.* here: the
// service worker wires it up, the Node tests use it directly.

export const LAUNCH_PATH = '/bc-launch';

const LAUNCH_URL = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):(\d{1,5})\/bc-launch\/?#([A-Za-z0-9_-]{16,128})$/;

/** Close codes server.py uses to refuse a connection. */
export const CLOSE_BAD_TOKEN = 4403; // unknown / expired launch token
export const CLOSE_AGENT_BUSY = 4409; // an agent session owns the bridge

/**
 * @param {string | undefined | null} url
 * @returns {{ port: number, token: string } | null}
 */
export function parseLaunchUrl(url) {
  const match = LAUNCH_URL.exec(String(url || ''));
  if (!match) return null;
  const port = Number(match[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { port, token: match[2] };
}

/**
 * WebSocket URL of the bridge, with the launch token when an agent session is on.
 * @param {string} host @param {number} port @param {string | null | undefined} token
 * @param {boolean} [probe]
 */
export function bridgeUrl(host, port, token, probe = false) {
  const base = `ws://${host}:${port}`;
  if (!token) return base;
  return `${base}/?launch=${encodeURIComponent(token)}${probe ? '&probe=1' : ''}`;
}

/**
 * One-off connection that asks the server whether a launch token is live.
 * The server answers {"type":"launchAccepted"} or closes with 4403; the probe
 * never replaces the main bridge connection on the server side.
 * @param {string} url
 * @param {{ WebSocketImpl?: typeof WebSocket, timeoutMs?: number }} [options]
 * @returns {Promise<boolean>}
 */
export function probeLaunch(url, options = {}) {
  const WebSocketImpl = options.WebSocketImpl || globalThis.WebSocket;
  const timeoutMs = options.timeoutMs || 5000;
  return new Promise((resolve) => {
    let settled = false;
    /** @type {WebSocket | null} */
    let ws = null;
    const finish = (/** @type {boolean} */ value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws?.close(1000, 'probe done');
      } catch {
        /* already closed */
      }
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    try {
      ws = new WebSocketImpl(url);
    } catch {
      finish(false);
      return;
    }
    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(String(event.data));
        finish(!!message && message.type === 'launchAccepted');
      } catch {
        finish(false);
      }
    };
    ws.onerror = () => finish(false);
    ws.onclose = () => finish(false);
  });
}
