// Offscreen document: the service worker has no matchMedia, so this page
// watches prefers-color-scheme (follows the Chrome/OS theme) and reports it.
'use strict';

const query = matchMedia('(prefers-color-scheme: dark)');

function report() {
  chrome.runtime.sendMessage({ type: 'bc-theme', dark: query.matches }).catch(() => {});
}

query.addEventListener('change', report);
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message && message.type === 'bc-theme-query') {
    sendResponse({ dark: query.matches });
  }
});
report();
