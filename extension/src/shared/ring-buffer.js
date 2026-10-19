// @ts-check

/**
 * Bounded FIFO: keeps the newest `capacity` items and counts what fell out.
 * @template T
 */
export class RingBuffer {
  /** @param {number} capacity */
  constructor(capacity) {
    this.capacity = capacity;
    /** @type {T[]} */
    this.items = [];
    /** Items evicted because the buffer was full (since the last clear). */
    this.dropped = 0;
    /** Items ever pushed (since the last clear). */
    this.total = 0;
  }

  /** @param {T} item */
  push(item) {
    this.items.push(item);
    this.total += 1;
    const extra = this.items.length - this.capacity;
    if (extra > 0) {
      this.items.splice(0, extra);
      this.dropped += extra;
    }
  }

  clear() {
    this.items = [];
    this.dropped = 0;
    this.total = 0;
  }

  /** @param {number} n newest n items, oldest first */
  last(n) {
    return n >= this.items.length ? this.items.slice() : this.items.slice(this.items.length - n);
  }

  get size() {
    return this.items.length;
  }
}
