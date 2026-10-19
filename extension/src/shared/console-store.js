// @ts-check
import { RingBuffer } from './ring-buffer.js';
import { truncate } from './util.js';

export const CONSOLE_LEVELS = ['all', 'error', 'warning', 'info', 'log', 'debug', 'exception', 'navigation', 'diagnostic'];
const MAX_TEXT = 10_000;
const MAX_FRAMES = 12;

/** Runtime.consoleAPICalled type -> level */
export function levelOfConsoleType(type) {
  switch (type) {
    case 'error':
    case 'assert':
      return 'error';
    case 'warning':
      return 'warning';
    case 'info':
      return 'info';
    case 'debug':
    case 'verbose':
      return 'debug';
    default:
      return 'log';
  }
}

/** Log.entryAdded level -> level */
export function levelOfLogEntry(level) {
  if (level === 'verbose') return 'debug';
  if (level === 'error' || level === 'warning' || level === 'info') return level;
  return 'log';
}

function previewValue(p) {
  if (p.type === 'string') return JSON.stringify(p.value);
  // CDP sends functions in previews with an empty value; DevTools shows ƒ.
  if (p.type === 'function') return 'ƒ';
  if (p.type === 'accessor') return '(...)';
  if (p.type === 'object' && p.valuePreview) return formatPreview(p.valuePreview);
  if (p.type === 'object' && p.subtype === 'null') return 'null';
  if (p.value !== undefined) return String(p.value);
  return p.subtype || p.type;
}

function formatPreview(preview) {
  if (!preview) return '';
  if (['error', 'regexp', 'date', 'node', 'promise'].includes(preview.subtype)) return preview.description || preview.subtype;
  const props = (preview.properties || []).map((p) => (preview.subtype === 'array' || preview.subtype === 'typedarray' ? previewValue(p) : `${p.name}: ${previewValue(p)}`));
  if (preview.entries) props.push(...preview.entries.map((e) => (e.key ? `${formatPreview(e.key)} => ${formatPreview(e.value)}` : formatPreview(e.value))));
  if (preview.overflow) props.push('…');
  if (preview.subtype === 'array' || preview.subtype === 'typedarray') return `[${props.join(', ')}]`;
  const head = preview.description && preview.description !== 'Object' ? `${preview.description} ` : '';
  return `${head}{${props.join(', ')}}`;
}

/** Text for a CDP Runtime.RemoteObject, close to what DevTools shows. */
export function formatRemoteObject(o) {
  if (!o) return 'undefined';
  if (o.unserializableValue) return o.unserializableValue;
  switch (o.type) {
    case 'undefined':
      return 'undefined';
    case 'string':
      return String(o.value);
    case 'number':
    case 'boolean':
    case 'bigint':
      return String(o.value ?? o.description);
    case 'symbol':
      return o.description || 'Symbol()';
    case 'function':
      return truncate(o.description || 'function', 200);
    case 'object':
      if (o.subtype === 'null') return 'null';
      if (o.subtype === 'error') return o.description || 'Error';
      if (o.preview) return formatPreview(o.preview);
      if (o.value !== undefined) {
        try {
          return JSON.stringify(o.value);
        } catch {
          /* fall through */
        }
      }
      return o.description || o.className || 'Object';
    default:
      return o.description || String(o.value);
  }
}

/** console.log("%s is %d", a, b) formatting, like DevTools. */
export function formatConsoleArgs(args = []) {
  if (!args.length) return '';
  const parts = [];
  let rest = args;
  const first = args[0];
  if (first && first.type === 'string' && /%[sdifoOc%]/.test(String(first.value))) {
    let i = 1;
    const text = String(first.value).replace(/%([sdifoOc%])/g, (m, c) => {
      if (c === '%') return '%';
      if (i >= args.length) return m;
      const a = args[i++];
      if (c === 'c') return '';
      if (c === 'd' || c === 'i') {
        const n = Number(a.value ?? a.description);
        return Number.isFinite(n) ? String(Math.trunc(n)) : 'NaN';
      }
      if (c === 'f') return String(Number(a.value ?? a.description));
      return formatRemoteObject(a);
    });
    parts.push(text);
    rest = args.slice(i);
  } else {
    parts.push(formatRemoteObject(first));
    rest = args.slice(1);
  }
  for (const a of rest) parts.push(formatRemoteObject(a));
  return truncate(parts.join(' '), MAX_TEXT);
}

/** @param {any} stackTrace Runtime.StackTrace */
export function formatStack(stackTrace) {
  if (!stackTrace || !Array.isArray(stackTrace.callFrames) || !stackTrace.callFrames.length) return undefined;
  return stackTrace.callFrames
    .slice(0, MAX_FRAMES)
    .map((f) => `    at ${f.functionName || '(anonymous)'} (${f.url || '<anonymous>'}:${(f.lineNumber ?? 0) + 1}:${(f.columnNumber ?? 0) + 1})`)
    .join('\n');
}

/**
 * Dedupe key part for console arguments that does not depend on previews:
 * Chrome replays the history after re-attach WITHOUT object previews, so the
 * formatted text changes ("[ƒ, ƒ]" -> "Array(2)") and a text-based key let
 * every console.log with an object in again.
 * @param {any[]} args
 */
function argsKey(args = []) {
  return args
    .map((a) => {
      if (!a) return '?';
      if (a.type === 'object' || a.type === 'function') return `${a.type}:${a.subtype || ''}`;
      return `${a.type}:${String(a.value ?? a.unserializableValue ?? a.description ?? '').slice(0, 80)}`;
    })
    .join('|')
    .slice(0, 400);
}

/**
 * @typedef {{
 *   seq: number, time: string, level: string, source: string, text: string,
 *   url?: string, line?: number, column?: number, stack?: string,
 * }} ConsoleEntry
 */

/**
 * Console journal for the connected tab: Runtime console API, uncaught
 * exceptions, browser Log entries, navigation and diagnostic markers.
 * Never cleared implicitly. Duplicates (history replayed after re-enable)
 * are dropped by key.
 */
export class ConsoleStore {
  /** @param {number} capacity */
  constructor(capacity = 1000) {
    /** @type {RingBuffer<ConsoleEntry>} */
    this.buffer = new RingBuffer(capacity);
    this.seq = 0;
    /** @type {Set<string>} */
    this.keys = new Set();
    /** @type {string[]} */
    this.keyOrder = [];
    this.lastEventAt = 0;
    this.duplicates = 0;
  }

  /** @param {Omit<ConsoleEntry, 'seq' | 'time'>} entry @param {number} [timestamp] ms @param {string} [dedupeKey] */
  add(entry, timestamp = Date.now(), dedupeKey) {
    if (dedupeKey) {
      if (this.keys.has(dedupeKey)) {
        this.duplicates += 1;
        return null;
      }
      this.keys.add(dedupeKey);
      this.keyOrder.push(dedupeKey);
      if (this.keyOrder.length > 4000) this.keys.delete(/** @type {string} */ (this.keyOrder.shift()));
    }
    this.seq += 1;
    const full = { seq: this.seq, time: new Date(timestamp).toISOString(), ...entry };
    for (const k of Object.keys(full)) if (full[k] === undefined) delete full[k];
    this.buffer.push(full);
    this.lastEventAt = Date.now();
    return full;
  }

  /** Runtime.consoleAPICalled */
  onConsoleApi(p) {
    const frame = p.stackTrace && p.stackTrace.callFrames && p.stackTrace.callFrames[0];
    const text = formatConsoleArgs(p.args || []);
    const level = levelOfConsoleType(p.type);
    const stack = level === 'error' || p.type === 'trace' ? formatStack(p.stackTrace) : undefined;
    return this.add(
      { level, source: 'console', text: p.type === 'assert' && !text ? 'Assertion failed' : text, url: frame?.url || undefined, line: frame ? frame.lineNumber + 1 : undefined, column: frame ? frame.columnNumber + 1 : undefined, stack },
      p.timestamp || Date.now(),
      // No stack/location in the key either: only the V8 timestamp, type and
      // preview-independent arguments are guaranteed to be identical on replay.
      `c|${p.timestamp}|${p.type}|${(p.args || []).length}|${argsKey(p.args)}`,
    );
  }

  /** Runtime.exceptionThrown */
  onException(p) {
    const d = p.exceptionDetails || {};
    const description = d.exception && (d.exception.description || (d.exception.value !== undefined ? String(d.exception.value) : ''));
    const firstLine = description ? description.split('\n')[0] : '';
    const text = firstLine ? `${d.text && d.text !== firstLine ? `${d.text} ` : ''}${firstLine}` : d.text || 'Uncaught exception';
    const stack = formatStack(d.stackTrace) || (description && description.includes('\n') ? description.split('\n').slice(1).join('\n') : undefined);
    return this.add(
      { level: 'exception', source: 'exception', text: truncate(text, MAX_TEXT), url: d.url || undefined, line: d.lineNumber !== undefined ? d.lineNumber + 1 : undefined, column: d.columnNumber !== undefined ? d.columnNumber + 1 : undefined, stack },
      p.timestamp || Date.now(),
      `e|${p.timestamp}|${d.exceptionId}|${text.slice(0, 200)}`,
    );
  }

  /** Log.entryAdded (network errors, CSP, deprecations, interventions...) */
  onLogEntry(p) {
    const e = p.entry || {};
    const text = truncate(String(e.text || ''), MAX_TEXT);
    return this.add(
      { level: levelOfLogEntry(e.level), source: `browser:${e.source || 'other'}`, text, url: e.url || undefined, line: e.lineNumber !== undefined ? e.lineNumber + 1 : undefined, stack: formatStack(e.stackTrace) },
      e.timestamp || Date.now(),
      `l|${e.timestamp}|${e.source}|${text.slice(0, 200)}`,
    );
  }

  /** @param {'navigation' | 'diagnostic'} level @param {string} text @param {string} [url] */
  mark(level, text, url) {
    return this.add({ level, source: level, text, url });
  }

  clear() {
    this.buffer.clear();
    // keep dedupe keys: a later history replay must not resurrect cleared entries
  }

  /** Forget everything, including dedupe keys (new tab). */
  reset() {
    this.buffer.clear();
    this.keys.clear();
    this.keyOrder = [];
    this.duplicates = 0;
  }

  /** @param {{limit?: number, level?: string}} options */
  query({ limit = 100, level = 'all' } = {}) {
    const items = level === 'all' ? this.buffer.items : this.buffer.items.filter((e) => e.level === level);
    const logs = items.length > limit ? items.slice(items.length - limit) : items.slice();
    return { total: this.buffer.total, buffered: this.buffer.size, matched: items.length, returned: logs.length, dropped: this.buffer.dropped, logs };
  }

  stats() {
    const counts = {};
    for (const e of this.buffer.items) counts[e.level] = (counts[e.level] || 0) + 1;
    return {
      buffered: this.buffer.size,
      capacity: this.buffer.capacity,
      total: this.buffer.total,
      dropped: this.buffer.dropped,
      duplicatesSkipped: this.duplicates,
      byLevel: counts,
      lastEventAt: this.lastEventAt ? new Date(this.lastEventAt).toISOString() : null,
    };
  }
}
