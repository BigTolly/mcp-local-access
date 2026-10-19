// @ts-check
import { errorMessage, sleep } from '../shared/util.js';

export const AGENT_FILE = 'src/page/agent.js';

/**
 * Runs inside the page (isolated world). Must be self-contained.
 * @param {string} name @param {any} args
 */
function invoke(name, args) {
  // @ts-ignore injected global
  const agent = globalThis.__browserControl;
  if (!agent) return { ok: false, missing: true, error: 'page agent is not loaded' };
  return agent.call(name, args);
}

/** Turn chrome.scripting errors into something the AI can act on. */
export function explainInjectionError(message, url = '') {
  if (/Cannot access|cannot be scripted|chrome:\/\/|extensions gallery|Missing host permission/i.test(message)) {
    return `This page cannot be automated${url ? ` (${url})` : ''}: Chrome does not let extensions into chrome://, Chrome Web Store, other extensions' pages and similar. Navigate to a regular website first.`;
  }
  if (/error page/i.test(message)) {
    return 'The tab shows a browser error page (no network / bad address). Navigate to another URL.';
  }
  if (/No tab with id/i.test(message)) return 'No tab is connected';
  return message;
}

const TRANSIENT = /Frame with ID 0 was removed|document was unloaded|context invalidated|No frame with id|The frame was removed|Execution context was destroyed/i;

/** Calls into src/page/agent.js in the connected tab's main frame. */
export class PageAgent {
  /**
   * @param {number} tabId @param {string} name @param {object} [args]
   */
  async call(tabId, name, args = {}) {
    let lastError = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        let out = await this.run(tabId, name, args);
        if (out && out.missing) {
          await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: [AGENT_FILE] });
          out = await this.run(tabId, name, args);
        }
        if (!out) throw new Error(`The page did not answer ${name} (it may be navigating).`);
        if (!out.ok) {
          const failure = new Error(out.error || `${name} failed`);
          // @ts-ignore mark errors raised by the agent itself: no retry
          failure.fromAgent = true;
          throw failure;
        }
        return out.value;
      } catch (error) {
        // @ts-ignore
        if (error && error.fromAgent) throw error;
        lastError = errorMessage(error);
        if (TRANSIENT.test(lastError) || /did not answer/.test(lastError)) {
          await sleep(300 + attempt * 300);
          continue;
        }
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        throw new Error(explainInjectionError(lastError, tab?.url));
      }
    }
    throw new Error(`${name}: ${lastError}`);
  }

  /** @param {number} tabId @param {string} name @param {object} args */
  async run(tabId, name, args) {
    const results = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      func: invoke,
      args: [name, args],
    });
    return results && results[0] ? results[0].result : undefined;
  }
}
