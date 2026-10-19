// @ts-check
import { rasterizeIcon, ICON_COLORS } from '../shared/icon-raster.js';

const SIZES = [16, 24, 32];

/** @typedef {'light' | 'dark'} Theme */

/**
 * Toolbar icon: theme-colored lines everywhere, green lines on the
 * connected tab while the server link is open. No background.
 *
 * Tab-specific icons cannot be "unset" in the chrome.action API, so every
 * tab that ever got a specific icon is remembered and repainted on theme
 * changes.
 */
export class IconController {
  constructor() {
    /** @type {Theme} */
    this.theme = 'light';
    /** @type {Map<string, Record<number, ImageData>>} */
    this.cache = new Map();
    /** @type {Set<number>} */
    this.touchedTabs = new Set();
  }

  /** @param {'light' | 'dark' | 'connected'} variant */
  imageSet(variant) {
    let set = this.cache.get(variant);
    if (!set) {
      set = {};
      for (const size of SIZES) {
        set[size] = new ImageData(rasterizeIcon(size, ICON_COLORS[variant]), size, size);
      }
      this.cache.set(variant, set);
    }
    return set;
  }

  /**
   * @param {{ tabId: number | null, linkOpen: boolean, waiting: boolean, paused?: boolean }} state
   */
  async refresh(state) {
    const base = this.imageSet(this.theme);
    await chrome.action.setIcon({ imageData: base }).catch(() => {});
    await chrome.action.setTitle({ title: 'Browser Control: not connected' }).catch(() => {});
    for (const tabId of this.touchedTabs) {
      if (tabId === state.tabId) continue;
      await chrome.action.setIcon({ tabId, imageData: base }).catch(() => this.touchedTabs.delete(tabId));
      await chrome.action.setTitle({ tabId, title: 'Browser Control: not connected' }).catch(() => {});
    }
    if (state.tabId == null) return;
    const green = state.linkOpen;
    const title = green
      ? state.paused
        ? 'Browser Control: connected; debugger paused (Chrome bar closed), resumes on the next command'
        : 'Browser Control: connected to Local Access'
      : state.waiting
        ? 'Browser Control: tab selected, waiting for Local Access…'
        : 'Browser Control: tab selected';
    this.touchedTabs.add(state.tabId);
    await chrome.action
      .setIcon({ tabId: state.tabId, imageData: green ? this.imageSet('connected') : base })
      .catch(() => {});
    await chrome.action.setTitle({ tabId: state.tabId, title }).catch(() => {});
  }

  /** @param {number} tabId */
  forget(tabId) {
    this.touchedTabs.delete(tabId);
  }
}
