// @ts-check

const MAX_PIXELS = 16_000_000; // keeps the base64 PNG well under server.py's 32 MB check
const MAX_DIM = 16_384; // GPU texture limit for one capture
const MAX_BASE64 = 31_000_000;

/**
 * Compute Page.captureScreenshot parameters. Pure: exported for tests.
 * @param {{mode: 'viewport' | 'full_page', scale: 'original' | 'reduced'}} options
 * @param {{css: {pageX: number, pageY: number, clientWidth: number, clientHeight: number}, content: {width: number, height: number}, dpr: number}} m
 */
export function captureParams({ mode, scale }, m) {
  const dpr = m.dpr > 0 ? m.dpr : 1;
  /** @type {{x: number, y: number, width: number, height: number}} */
  let clip;
  if (mode === 'full_page') {
    clip = { x: 0, y: 0, width: Math.ceil(Math.max(m.content.width, m.css.clientWidth)), height: Math.ceil(Math.max(m.content.height, m.css.clientHeight)) };
  } else {
    clip = { x: m.css.pageX, y: m.css.pageY, width: m.css.clientWidth, height: m.css.clientHeight };
  }
  let s = 1;
  if (scale === 'reduced') s = Math.min(1, 1024 / (clip.width * dpr), 768 / (clip.height * dpr));
  const notes = [];
  const pixels = clip.width * dpr * s * (clip.height * dpr * s);
  if (pixels > MAX_PIXELS) {
    s *= Math.sqrt(MAX_PIXELS / pixels) * 0.995; // margin for rounding to whole pixels
    notes.push('downscaled to the pixel limit');
  }
  const longest = Math.max(clip.width, clip.height) * dpr * s;
  if (longest > MAX_DIM) {
    s *= MAX_DIM / longest;
    notes.push('downscaled to the 16384 px side limit');
  }
  /** @type {Record<string, any>} */
  const params = { format: 'png', fromSurface: true, captureBeyondViewport: mode === 'full_page' };
  if (mode === 'full_page' || s !== 1) params.clip = { ...clip, scale: s };
  return {
    params,
    notes,
    expected: { width: Math.round(clip.width * dpr * s), height: Math.round(clip.height * dpr * s) },
  };
}

/** @param {any} ctx */
export function captureHandlers(ctx) {
  async function capture(mode, scale) {
    ctx.session.requireTab();
    const send = (method, params) => ctx.cdp.send(method, params, 30_000);
    const metrics = await send('Page.getLayoutMetrics', {});
    const css = metrics.cssVisualViewport || metrics.visualViewport;
    const content = metrics.cssContentSize || metrics.contentSize;
    const dprResult = await send('Runtime.evaluate', { expression: 'window.devicePixelRatio', returnByValue: true });
    const dpr = Number(dprResult && dprResult.result && dprResult.result.value) || 1;
    const { params } = captureParams({ mode, scale }, { css, content, dpr });
    const shot = await send('Page.captureScreenshot', params);
    const data = shot && shot.data;
    if (typeof data !== 'string' || !data) throw new Error('Chrome returned an empty screenshot');
    if (data.length > MAX_BASE64) throw new Error('Screenshot is too large to transfer; use scale=reduced or mode=viewport');
    return data;
  }

  return {
    /** Legacy tool: viewport, fitted into 1024x768 like the donor. */
    browser_screenshot: () => capture('viewport', 'reduced'),

    async browser_capture({ mode = 'viewport', scale = 'original' }) {
      if (mode !== 'viewport' && mode !== 'full_page') throw new Error('mode must be viewport or full_page');
      if (scale !== 'original' && scale !== 'reduced') throw new Error('scale must be original or reduced');
      return capture(mode, scale);
    },
  };
}
