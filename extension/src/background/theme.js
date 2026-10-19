// @ts-check

const OFFSCREEN_URL = 'src/offscreen/theme.html';

/** Make sure the offscreen theme probe exists (it lives until the browser closes). */
export async function ensureThemeProbe() {
  if (!chrome.offscreen) return false;
  try {
    // @ts-ignore getContexts is Chrome 116+
    const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (existing && existing.length) return true;
  } catch {
    /* older Chrome: fall through and try to create */
  }
  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      // @ts-ignore MATCH_MEDIA is a valid reason
      reasons: ['MATCH_MEDIA'],
      justification: 'Detect the light/dark browser theme to color the toolbar icon.',
    });
    return true;
  } catch (error) {
    // "Only a single offscreen document may be created" means it already exists.
    return /single offscreen/i.test(String(error));
  }
}

/** Ask the probe directly (used at startup). @returns {Promise<'light'|'dark'|null>} */
export async function queryTheme() {
  try {
    const reply = await chrome.runtime.sendMessage({ type: 'bc-theme-query' });
    if (reply && typeof reply.dark === 'boolean') return reply.dark ? 'dark' : 'light';
  } catch {
    /* probe not ready yet; it will report on load */
  }
  return null;
}
