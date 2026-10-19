// @ts-check
import { redactHeaders, redactUrl } from './redact.js';

/**
 * @typedef {{
 *   id: string, cdpId: string, generation: number, method: string, url: string, type?: string,
 *   state: 'pending' | 'finished' | 'failed' | 'redirected', startTs: number, endTs?: number,
 *   wallTime?: number, status?: number, statusText?: string, mimeType?: string, protocol?: string,
 *   fromCache?: boolean, encodedDataLength?: number, errorText?: string, canceled?: boolean,
 *   blockedReason?: string, redirectedTo?: string, redirectedFrom?: string, hasPostData: boolean,
 *   initiator?: string, requestHeaders: Record<string, string>, responseHeaders?: Record<string, string>,
 * }} NetEntry
 */

/**
 * Opt-in network journal built from CDP Network.* events. IDs are opaque
 * (n1, n2, ...): one entry per hop, so a redirect chain is several entries
 * with redirectedFrom/redirectedTo links.
 */
export class NetworkStore {
  /** @param {number} capacity */
  constructor(capacity = 300) {
    this.capacity = capacity;
    this.enabled = false;
    this.startedAt = 0;
    /** @type {Map<string, NetEntry>} */
    this.entries = new Map();
    /** @type {Map<string, string>} cdp requestId -> current opaque id */
    this.byCdp = new Map();
    this.seq = 0;
    this.dropped = 0;
    this.total = 0;
  }

  /** @param {NetEntry} entry */
  insert(entry) {
    this.entries.set(entry.id, entry);
    this.total += 1;
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value;
      const old = this.entries.get(oldest);
      this.entries.delete(oldest);
      if (old && this.byCdp.get(old.cdpId) === oldest) this.byCdp.delete(old.cdpId);
      this.dropped += 1;
    }
  }

  current(cdpId) {
    const id = this.byCdp.get(cdpId);
    return id ? this.entries.get(id) : undefined;
  }

  /** Network.requestWillBeSent @param {any} p @param {number} generation */
  onRequestWillBeSent(p, generation) {
    if (!this.enabled) return;
    const previous = this.current(p.requestId);
    const id = `n${++this.seq}`;
    if (p.redirectResponse && previous) {
      this.applyResponse(previous, p.redirectResponse);
      previous.state = 'redirected';
      previous.endTs = p.timestamp;
      previous.redirectedTo = id;
    }
    const req = p.request || {};
    this.insert({
      id,
      cdpId: p.requestId,
      generation,
      method: req.method || 'GET',
      url: redactUrl(req.url || ''),
      type: p.type,
      state: 'pending',
      startTs: p.timestamp,
      wallTime: p.wallTime,
      hasPostData: !!req.hasPostData,
      initiator: p.initiator && p.initiator.type,
      requestHeaders: redactHeaders(req.headers),
      redirectedFrom: p.redirectResponse && previous ? previous.id : undefined,
    });
    this.byCdp.set(p.requestId, id);
  }

  /** Network.responseReceived */
  onResponseReceived(p) {
    if (!this.enabled) return;
    const e = this.current(p.requestId);
    if (!e) return;
    this.applyResponse(e, p.response || {});
    if (p.type) e.type = p.type;
  }

  /** Network.loadingFinished */
  onLoadingFinished(p) {
    if (!this.enabled) return;
    const e = this.current(p.requestId);
    if (!e) return;
    e.state = 'finished';
    e.endTs = p.timestamp;
    e.encodedDataLength = p.encodedDataLength;
  }

  /** Network.loadingFailed */
  onLoadingFailed(p) {
    if (!this.enabled) return;
    const e = this.current(p.requestId);
    if (!e) return;
    e.state = 'failed';
    e.endTs = p.timestamp;
    e.errorText = p.errorText;
    e.canceled = !!p.canceled;
    if (p.blockedReason) e.blockedReason = p.blockedReason;
    if (p.type) e.type = p.type;
  }

  /** @param {NetEntry} e @param {any} r */
  applyResponse(e, r) {
    e.status = r.status;
    e.statusText = r.statusText;
    e.mimeType = r.mimeType;
    e.protocol = r.protocol;
    e.fromCache = !!(r.fromDiskCache || r.fromPrefetchCache || r.fromServiceWorker);
    e.responseHeaders = redactHeaders(r.headers);
  }

  /** @param {NetEntry} e */
  summary(e) {
    return {
      id: e.id,
      method: e.method,
      url: e.url,
      status: e.status ?? null,
      type: e.type ?? null,
      mimeType: e.mimeType ?? null,
      state: e.state,
      durationMs: e.endTs !== undefined ? Math.round((e.endTs - e.startTs) * 1000) : null,
      size: e.encodedDataLength ?? null,
      error: e.errorText ?? null,
      redirectedTo: e.redirectedTo ?? null,
    };
  }

  /** @param {number} limit */
  list(limit) {
    const all = [...this.entries.values()];
    const slice = all.length > limit ? all.slice(all.length - limit) : all;
    return {
      enabled: this.enabled,
      capturingSince: this.startedAt ? new Date(this.startedAt).toISOString() : null,
      total: this.total,
      buffered: this.entries.size,
      dropped: this.dropped,
      returned: slice.length,
      requests: slice.map((e) => this.summary(e)),
    };
  }

  /** @param {string} id */
  detail(id) {
    const e = this.entries.get(id);
    if (!e) throw new Error(`Unknown request_id "${id}". Call browser_network action=list first.`);
    const { cdpId: _cdp, generation: _gen, startTs: _s, endTs: _e, ...rest } = e;
    return { ...rest, ...this.summary(e), startedAt: e.wallTime ? new Date(e.wallTime * 1000).toISOString() : null };
  }

  get(id) {
    return this.entries.get(id);
  }

  start() {
    if (!this.enabled) this.startedAt = Date.now();
    this.enabled = true;
  }

  stop() {
    this.enabled = false;
  }

  clear() {
    this.entries.clear();
    this.byCdp.clear();
    this.dropped = 0;
    this.total = 0;
  }

  stats() {
    return { enabled: this.enabled, buffered: this.entries.size, capacity: this.capacity, total: this.total, dropped: this.dropped };
  }
}
