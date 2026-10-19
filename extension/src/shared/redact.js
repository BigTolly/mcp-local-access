// @ts-check
/**
 * Best-effort redaction for network diagnostics. NOT a guarantee of
 * anonymization: secrets can hide in URL paths, free text or odd field names.
 */

export const MASK = '[redacted]';

export const SENSITIVE_KEY = /(pass(word|wd|phrase)?|secret|token|auth|session|cookie|api[-_]?key|apikey|credential|private|signature|jwt|bearer|otp|csrf|xsrf|^pin$|^key$|^sid$)/i;
const JWT = /\beyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]{5,}\b/g;
const BEARER = /\b(Bearer|Basic|Token)\s+[\w.~+/=-]{8,}/gi;

/** Headers whose values are kept as-is (lower-case names). */
const SAFE_HEADERS = new Set([
  'accept', 'accept-encoding', 'accept-language', 'accept-ranges', 'access-control-allow-credentials',
  'access-control-allow-headers', 'access-control-allow-methods', 'access-control-allow-origin',
  'access-control-expose-headers', 'access-control-max-age', 'access-control-request-headers',
  'access-control-request-method', 'age', 'cache-control', 'connection', 'content-disposition',
  'content-encoding', 'content-language', 'content-length', 'content-type', 'cross-origin-embedder-policy',
  'cross-origin-opener-policy', 'cross-origin-resource-policy', 'date', 'etag', 'expires', 'host',
  'keep-alive', 'last-modified', 'origin', 'pragma', 'priority', 'range', 'referrer-policy', 'retry-after',
  'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform', 'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site',
  'sec-fetch-user', 'server', 'server-timing', 'strict-transport-security', 'timing-allow-origin',
  'transfer-encoding', 'upgrade-insecure-requests', 'user-agent', 'vary', 'via', 'x-content-type-options',
  'x-frame-options', 'x-requested-with', 'x-xss-protection', ':method', ':scheme', ':authority', ':status',
]);
const URL_HEADERS = new Set(['location', 'referer', 'content-location', ':path']);

/** Hide credentials, query values and the fragment; keep scheme/host/path and query keys. */
export function redactUrl(url) {
  if (typeof url !== 'string' || !url) return url;
  if (url.startsWith('data:')) {
    const comma = url.indexOf(',');
    return `${url.slice(0, Math.min(comma > 0 ? comma : 40, 60))},[${Math.max(0, url.length - comma - 1)} chars]`;
  }
  if (url.startsWith('/') && !url.startsWith('//')) {
    // :path pseudo-header or relative URL
    return redactUrl(`http://x${url}`).replace(/^http:\/\/x/, '');
  }
  let u;
  try {
    u = new URL(url);
  } catch {
    return url.length > 200 ? `${url.slice(0, 200)}…` : url;
  }
  if (u.username) u.username = 'redacted';
  if (u.password) u.password = 'redacted';
  let out = `${u.protocol}//${u.username ? `${u.username}${u.password ? `:${u.password}` : ''}@` : ''}${u.host}${u.pathname}`;
  if (u.search) {
    const keys = u.search
      .slice(1)
      .split('&')
      .filter(Boolean)
      .map((pair) => {
        const eq = pair.indexOf('=');
        return eq < 0 ? pair : `${pair.slice(0, eq)}=***`;
      });
    out += `?${keys.join('&')}`;
  }
  if (u.hash) out += '#***';
  return out;
}

/** @param {Record<string, string> | undefined} headers */
export function redactHeaders(headers) {
  /** @type {Record<string, string>} */
  const out = {};
  if (!headers || typeof headers !== 'object') return out;
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (URL_HEADERS.has(lower)) out[name] = redactUrl(String(value));
    else if (SAFE_HEADERS.has(lower) && !SENSITIVE_KEY.test(lower)) out[name] = String(value);
    else out[name] = MASK;
  }
  return out;
}

/** Redact secrets inside free text: key=value / "key": "value", JWTs, Bearer tokens. */
export function redactText(text) {
  // Tokens first: "Authorization: Bearer xyz" must lose xyz, not just "Bearer".
  return String(text)
    .replace(BEARER, (_m, scheme) => `${scheme} ${MASK}`)
    .replace(JWT, MASK)
    // Linear-time on purpose: the key starts only at a word boundary (lookbehind)
    // and is at most 64 chars, so a 1 MB run of letters cannot backtrack
    // quadratically (that froze the service worker on /api/large).
    .replace(/(?<![\w.-])(["']?)([\w.-]{1,64})\1([ \t]{0,4}[:=][ \t]{0,4})("(?:[^"\\\n]|\\.){0,4096}"|'[^'\n]{0,4096}'|[^\s&,;}"']{1,4096})/g, (m, q, key, sep, value) => {
      if (!SENSITIVE_KEY.test(key)) return m;
      const quote = value.startsWith('"') ? '"' : value.startsWith("'") ? "'" : '';
      return `${q}${key}${q}${sep}${quote}${MASK}${quote}`;
    });
}

function redactValue(value, depth) {
  if (depth > 20) return value;
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = SENSITIVE_KEY.test(k) && v !== null && typeof v !== 'object' ? MASK : redactValue(v, depth + 1);
    return out;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        return JSON.stringify(redactValue(JSON.parse(trimmed), depth + 1));
      } catch {
        /* not JSON */
      }
    }
    return redactText(value);
  }
  return value;
}

/**
 * Body redaction: JSON is walked structurally (including JSON nested in
 * strings), everything else goes through redactText.
 * @param {string} text @param {string} [mimeType]
 */
export function redactBody(text, mimeType = '') {
  const trimmed = String(text).trim();
  const looksJson = /json/i.test(mimeType) || trimmed.startsWith('{') || trimmed.startsWith('[');
  if (looksJson) {
    try {
      return JSON.stringify(redactValue(JSON.parse(trimmed), 0));
    } catch {
      /* fall through */
    }
  }
  return redactText(text);
}

const TEXT_MIME = /^(text\/|application\/(json|[\w.+-]*\+json|javascript|ecmascript|xml|[\w.+-]*\+xml|x-www-form-urlencoded|graphql)|image\/svg\+xml)/i;
/** @param {string | undefined} mime */
export function isTextMime(mime) {
  return !!mime && TEXT_MIME.test(mime);
}
