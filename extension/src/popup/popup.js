// Browser Control popup. Talks to the service worker via runtime messages.
'use strict';

const $ = (id) => document.getElementById(id);
const dark = matchMedia('(prefers-color-scheme: dark)');
let activeTab = null;
let busy = false;

async function rpc(cmd, args = {}) {
  const reply = await chrome.runtime.sendMessage({ type: 'bc-popup', cmd, ...args });
  if (!reply) throw new Error('The extension did not answer. Reload it in chrome://extensions.');
  if (!reply.ok) throw new Error(reply.error);
  return reply.value;
}

function showError(message) {
  const el = $('error');
  el.hidden = !message;
  el.textContent = message || '';
}

function serverText(bridge) {
  switch (bridge.status) {
    case 'open':
      return ['ok', `Connected (${bridge.url})`];
    case 'connecting':
      return ['wait', `Connecting to ${bridge.url}…`];
    case 'closed':
      return ['bad', `Local Access not reachable at ${bridge.url}, retrying`];
    default:
      return ['', 'Idle (connect a tab to start)'];
  }
}

function render(state) {
  $('version').textContent = `v${state.version}`;
  $('logo').src = `../../icons/${state.bridge.status === 'open' && state.tab && activeTab && state.tab.id === activeTab.id ? 'connected' : dark.matches ? 'dark' : 'light'}-32.png`;
  const [cls, text] = serverText(state.bridge);
  $('server').querySelector('.dot').className = `dot ${cls}`;
  $('server').querySelector('.text').textContent = text;
  $('server').title = state.bridge.lastError || '';

  const connectedHere = state.tab && activeTab && state.tab.id === activeTab.id;
  if (!state.tab) $('tab').textContent = 'Not connected';
  else $('tab').textContent = `${connectedHere ? 'This tab' : 'Other tab'}: ${state.tab.title || state.tab.url}`;
  $('tab').title = state.tab ? state.tab.url : '';

  const d = state.debugger;
  const paused = !!(state.tab && !d.attached && d.pausedByUser);
  $('debugger').textContent = !state.tab
    ? '—'
    : d.attached
      ? `Attached · ${d.domains.join(', ') || 'no domains'}`
      : paused
        ? 'Paused (Chrome bar closed) · resumes on the next command'
        : `Detached${d.lastDetach ? ` (${d.lastDetach.reason})` : ''}`;
  $('debugger').className = `value${paused ? ' warn' : ''}`;
  $('debugger').title = paused ? 'Cancel or ✕ on Chrome\'s debugging bar paused the debugger. The tab is still connected; the next command (or Resume) re-attaches it and Chrome shows the bar again.' : '';

  // Paused on this very tab: the same button resumes the debugger.
  $('connect').hidden = !!connectedHere && !paused;
  $('connect').textContent = connectedHere && paused ? 'Resume debugger' : state.tab ? 'Switch to this tab' : 'Connect this tab';
  $('barCancel').checked = state.settings.barCancel === 'disconnect';
  $('allowFile').checked = !!state.settings.allowFileUrls;
  $('disconnect').hidden = !state.tab;
  if (document.activeElement !== $('port')) $('port').value = state.settings.port;
  if (state.session.lastError && !state.tab) showError(state.session.lastError);
}

async function refresh() {
  if (busy) return;
  try {
    render(await rpc('state'));
  } catch (error) {
    showError(error.message);
  }
}

async function act(fn) {
  busy = true;
  showError('');
  for (const b of document.querySelectorAll('button')) b.disabled = true;
  try {
    const state = await fn();
    if (state && state.bridge) render(state);
  } catch (error) {
    showError(error.message);
  } finally {
    busy = false;
    for (const b of document.querySelectorAll('button')) b.disabled = false;
  }
}

$('connect').addEventListener('click', () => act(() => rpc('connect', { tabId: activeTab.id })));
$('disconnect').addEventListener('click', () => act(() => rpc('disconnect')));
$('portForm').addEventListener('submit', (event) => {
  event.preventDefault();
  act(() => rpc('setPort', { port: Number($('port').value) }));
});
$('barCancel').addEventListener('change', () =>
  act(() => rpc('setBarCancel', { value: $('barCancel').checked ? 'disconnect' : 'pause' })),
);
$('allowFile').addEventListener('change', () => act(() => rpc('setAllowFile', { value: $('allowFile').checked })));
$('diag').addEventListener('click', () =>
  act(async () => {
    const result = await rpc('diagnostics');
    $('diagOut').hidden = false;
    $('diagOut').textContent = JSON.stringify(result, null, 2);
    return null;
  }),
);

(async function start() {
  [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  // The popup sees the real theme too: a second source for the icon color.
  rpc('theme', { dark: dark.matches }).catch(() => {});
  await refresh();
  setInterval(refresh, 1000);
})();
