// @ts-check
/**
 * Browser Control icon: a browser window outline and a mouse cursor.
 * Lines only, transparent background. One geometry source for:
 *  - the static PNGs (tools/make-icons.mjs, Node), and
 *  - the live toolbar icon (service worker, ImageData).
 * Design space is 128x128.
 */

export const ICON_COLORS = Object.freeze({
  light: '#1F2937', // dark lines for a light browser theme
  dark: '#E5E7EB', // light lines for a dark browser theme
  connected: '#22C55E', // green: this tab is connected
  neutral: '#6B7280', // static PNGs for chrome://extensions (readable on both themes)
});

const DESIGN = 128;

/** @typedef {[number, number]} Pt */

/**
 * Closed polyline for a rounded rectangle.
 * @returns {Pt[]}
 */
function roundedRect(x0, y0, x1, y1, r, steps = 6) {
  /** @type {Pt[]} */
  const pts = [];
  const corners = [
    [x1 - r, y0 + r, -Math.PI / 2, 0],
    [x1 - r, y1 - r, 0, Math.PI / 2],
    [x0 + r, y1 - r, Math.PI / 2, Math.PI],
    [x0 + r, y0 + r, Math.PI, (3 * Math.PI) / 2],
  ];
  for (const [cx, cy, a0, a1] of corners) {
    for (let i = 0; i <= steps; i++) {
      const a = a0 + ((a1 - a0) * i) / steps;
      pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
  }
  return pts;
}

/** Window frame (top-left), tab bar line, and a cursor overlapping the bottom-right corner. */
export const WINDOW = { closed: true, points: roundedRect(8, 14, 104, 94, 13) };
export const TAB_BAR = { closed: false, points: /** @type {Pt[]} */ ([[8, 37], [104, 37]]) };
export const CURSOR = {
  closed: true,
  points: /** @type {Pt[]} */ ([
    [66, 58],
    [66, 119],
    [80, 105],
    [91, 125],
    [103, 119],
    [92, 99],
    [112, 99],
  ]),
};

/** Stroke width in output pixels for a given icon size. */
export function strokeWidthFor(size) {
  return Math.max(1.4, size * 0.07);
}

/** @param {string} hex */
export function parseHex(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`Bad color ${hex}`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** @param {{closed: boolean, points: Pt[]}} path @param {number} k */
function segmentsOf(path, k) {
  const p = path.points.map(([x, y]) => [x * k, y * k]);
  const segs = [];
  for (let i = 0; i < p.length - 1; i++) segs.push([p[i], p[i + 1]]);
  if (path.closed) segs.push([p[p.length - 1], p[0]]);
  return segs;
}

function distToSegment(px, py, [[ax, ay], [bx, by]]) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const qx = ax + t * dx - px;
  const qy = ay + t * dy - py;
  return Math.sqrt(qx * qx + qy * qy);
}

function minDist(px, py, segs) {
  let d = Infinity;
  for (const s of segs) d = Math.min(d, distToSegment(px, py, s));
  return d;
}

function insidePolygon(px, py, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Rasterize the icon into straight (non-premultiplied) RGBA.
 * The cursor knocks a gap out of the window lines, so the lines never cross.
 * @param {number} size output width/height in px
 * @param {string} hex line color
 * @returns {Uint8ClampedArray}
 */
export function rasterizeIcon(size, hex) {
  const [r, g, b] = parseHex(hex);
  const k = size / DESIGN;
  const half = strokeWidthFor(size) / 2;
  const gap = half * 1.6;
  const windowSegs = [...segmentsOf(WINDOW, k), ...segmentsOf(TAB_BAR, k)];
  const cursorSegs = segmentsOf(CURSOR, k);
  const cursorPts = CURSOR.points.map(([x, y]) => [x * k, y * k]);
  const out = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const dc = minDist(px, py, cursorSegs);
      const cursorA = clamp01(half + 0.5 - dc);
      const knock = insidePolygon(px, py, cursorPts) ? 1 : clamp01(half + gap + 0.5 - dc);
      const windowA = clamp01(half + 0.5 - minDist(px, py, windowSegs)) * (1 - knock);
      const a = Math.max(cursorA, windowA);
      const i = (y * size + x) * 4;
      out[i] = r;
      out[i + 1] = g;
      out[i + 2] = b;
      out[i + 3] = Math.round(a * 255);
    }
  }
  return out;
}

/** SVG source with the same geometry (for docs and design tools). */
export function iconSvg(hex) {
  const sw = (DESIGN * 0.07).toFixed(2);
  const pts = (p) => p.points.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" fill="none" stroke="${hex}" stroke-width="${sw}" stroke-linejoin="round" stroke-linecap="round">
  <defs><mask id="knock"><rect width="128" height="128" fill="#fff"/><polygon points="${pts(CURSOR)}" fill="#000" stroke="#000" stroke-width="${(DESIGN * 0.07 * 2.6).toFixed(2)}"/></mask></defs>
  <g mask="url(#knock)"><polygon points="${pts(WINDOW)}"/><polyline points="${pts(TAB_BAR)}"/></g>
  <polygon points="${pts(CURSOR)}"/>
</svg>
`;
}
