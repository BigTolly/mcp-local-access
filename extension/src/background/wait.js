// @ts-check
import { sleep } from '../shared/util.js';

/**
 * Resolve when the main frame of the tab finishes a navigation: full load,
 * error page, same-document (#hash / pushState) or back/forward-cache restore.
 * Never rejects: on timeout it resolves with {timedOut: true}, because a slow
 * page is still a usable page.
 * Register BEFORE triggering the navigation.
 * @param {number} tabId
 * @param {number} timeoutMs
 */
export function waitForNavigation(tabId, timeoutMs) {
  /** @type {(value: {kind: string, timedOut: boolean, error?: string}) => void} */
  let finish = () => {};
  const promise = new Promise((resolve) => {
    finish = resolve;
  });
  const isMain = (d) => d.tabId === tabId && d.frameId === 0;
  const onCompleted = (d) => isMain(d) && done({ kind: 'load', timedOut: false });
  const onError = (d) => isMain(d) && done({ kind: 'error', timedOut: false, error: d.error });
  const onSameDoc = (d) => isMain(d) && done({ kind: 'same-document', timedOut: false });
  const onTab = (id, info) => id === tabId && info.status === 'complete' && done({ kind: 'load', timedOut: false });
  const timer = setTimeout(() => done({ kind: 'timeout', timedOut: true }), timeoutMs);
  let settled = false;
  function cleanup() {
    clearTimeout(timer);
    chrome.webNavigation.onCompleted.removeListener(onCompleted);
    chrome.webNavigation.onErrorOccurred.removeListener(onError);
    chrome.webNavigation.onReferenceFragmentUpdated.removeListener(onSameDoc);
    chrome.webNavigation.onHistoryStateUpdated.removeListener(onSameDoc);
    chrome.tabs.onUpdated.removeListener(onTab);
  }
  function done(value) {
    if (settled) return;
    settled = true;
    cleanup();
    finish(value);
  }
  chrome.webNavigation.onCompleted.addListener(onCompleted);
  chrome.webNavigation.onErrorOccurred.addListener(onError);
  chrome.webNavigation.onReferenceFragmentUpdated.addListener(onSameDoc);
  chrome.webNavigation.onHistoryStateUpdated.addListener(onSameDoc);
  chrome.tabs.onUpdated.addListener(onTab);
  return { promise, cancel: () => done({ kind: 'cancelled', timedOut: false }) };
}

/**
 * Wait until the tab's status is "complete" (or the timeout passes).
 * @param {number} tabId @param {number} timeoutMs
 */
export async function waitTabReady(tabId, timeoutMs) {
  const tab = await chrome.tabs.get(tabId);
  if (tab.status === 'complete') return true;
  const nav = waitForNavigation(tabId, timeoutMs);
  const again = await chrome.tabs.get(tabId);
  if (again.status === 'complete') {
    nav.cancel();
    return true;
  }
  const result = await nav.promise;
  return !result.timedOut;
}

/**
 * After a click/keypress: give the page a moment, and if it started a
 * navigation, wait for it so the following snapshot sees the new page.
 * @param {number} tabId
 */
export async function settleAfterAction(tabId) {
  await sleep(120);
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab && tab.status === 'loading') await waitTabReady(tabId, 15_000);
}
