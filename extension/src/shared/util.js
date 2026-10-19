// @ts-check
/** Small helpers shared by the service worker and the Node tests. No chrome.* here. */

export const VERSION = '1.0.0';

/** @param {number} ms */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Reject when the promise does not settle in time.
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} message
 * @returns {Promise<T>}
 */
export function withTimeout(promise, ms, message) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return /** @type {Promise<T>} */ (Promise.race([promise, timeout]).finally(() => clearTimeout(timer)));
}

/**
 * Human-readable message from anything thrown, including CDP errors that
 * arrive as a JSON string like {"code":-32000,"message":"..."}.
 * @param {unknown} error
 */
export function errorMessage(error) {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : JSON.stringify(error);
  if (raw && raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.message === 'string') {
        return parsed.data ? `${parsed.message} (${parsed.data})` : parsed.message;
      }
    } catch {
      /* not JSON */
    }
  }
  return raw || 'Unknown error';
}

/**
 * @param {string} text
 * @param {number} max
 */
export function truncate(text, max) {
  if (typeof text !== 'string') text = String(text);
  return text.length > max ? `${text.slice(0, max)}… [${text.length - max} more chars]` : text;
}

/**
 * JSON-safe copy limited in size: returns the value, or a preview when too big.
 * @param {unknown} value
 * @param {number} maxChars
 */
export function clipJson(value, maxChars) {
  let text;
  try {
    text = JSON.stringify(value);
  } catch {
    return { unserializable: true };
  }
  if (text === undefined) return null;
  if (text.length <= maxChars) return value;
  return { truncated: true, length: text.length, preview: text.slice(0, maxChars) };
}

/** @param {unknown} n @param {number} lo @param {number} hi @param {string} name */
export function intInRange(n, lo, hi, name) {
  const v = Number(n);
  if (!Number.isInteger(v) || v < lo || v > hi) throw new Error(`${name} must be an integer ${lo}..${hi}`);
  return v;
}
