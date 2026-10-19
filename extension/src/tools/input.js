// @ts-check
import { pressKey } from '../shared/keyboard.js';
import { sleep } from '../shared/util.js';
import { settleAfterAction } from '../background/wait.js';

/** @param {any} ctx */
export function inputHandlers(ctx) {
  const send = (method, params) => ctx.cdp.send(method, params, 10_000);

  const mouse = (type, x, y, extra = {}) =>
    send('Input.dispatchMouseEvent', { type, x, y, button: 'none', buttons: 0, modifiers: 0, pointerType: 'mouse', ...extra });

  /** Click point for a ref, or null when only a DOM click is possible. */
  async function pointOf(tabId, ref, scroll = true) {
    const p = await ctx.agent.call(tabId, 'point', { ref, scroll });
    return p && !p.fallback ? p : null;
  }

  async function click(tabId, ref) {
    const p = await pointOf(tabId, ref);
    if (!p) {
      await ctx.agent.call(tabId, 'domClick', { ref });
      return;
    }
    await mouse('mouseMoved', p.x, p.y);
    await mouse('mousePressed', p.x, p.y, { button: 'left', buttons: 1, clickCount: 1 });
    await mouse('mouseReleased', p.x, p.y, { button: 'left', buttons: 0, clickCount: 1 });
  }

  return {
    async browser_click({ ref }) {
      const tabId = ctx.session.requireTab();
      await click(tabId, ref);
      await settleAfterAction(tabId);
      return null;
    },

    async browser_hover({ ref }) {
      const tabId = ctx.session.requireTab();
      const p = await pointOf(tabId, ref);
      if (!p) throw new Error(`Element ${ref} has no visible box to hover`);
      await mouse('mouseMoved', p.x, p.y);
      await sleep(80);
      return null;
    },

    async browser_drag({ startRef, endRef }) {
      const tabId = ctx.session.requireTab();
      let a = await pointOf(tabId, startRef);
      const b = await pointOf(tabId, endRef);
      a = await pointOf(tabId, startRef, false); // the end may have scrolled the page
      if (!a || !b) throw new Error('Both drag elements must be visible on the page');
      /** @type {any} */
      let dragData = null;
      const off = ctx.cdp.on('Input.dragIntercepted', (params) => {
        dragData = params.data;
      });
      await send('Input.setInterceptDrags', { enabled: true });
      try {
        await mouse('mouseMoved', a.x, a.y);
        await mouse('mousePressed', a.x, a.y, { button: 'left', buttons: 1, clickCount: 1 });
        const steps = 8;
        for (let i = 1; i <= steps; i++) {
          const x = a.x + ((b.x - a.x) * i) / steps;
          const y = a.y + ((b.y - a.y) * i) / steps;
          await mouse('mouseMoved', x, y, { button: 'left', buttons: 1 });
          if (dragData) break;
        }
        await sleep(60);
        if (dragData) {
          // HTML5 drag and drop: Chrome handed the drag to us, deliver it.
          await send('Input.dispatchDragEvent', { type: 'dragEnter', x: b.x, y: b.y, data: dragData });
          await send('Input.dispatchDragEvent', { type: 'dragOver', x: b.x, y: b.y, data: dragData });
          await send('Input.dispatchDragEvent', { type: 'drop', x: b.x, y: b.y, data: dragData });
        } else {
          // Mouse-event based drag (sortable lists, sliders, canvases).
          await mouse('mouseMoved', b.x, b.y, { button: 'left', buttons: 1 });
        }
      } finally {
        await mouse('mouseReleased', b.x, b.y, { button: 'left', buttons: 0, clickCount: 1 }).catch(() => {});
        await send('Input.setInterceptDrags', { enabled: false }).catch(() => {});
        off();
      }
      await settleAfterAction(tabId);
      return null;
    },

    async browser_type({ ref, text, submit }) {
      const tabId = ctx.session.requireTab();
      const value = String(text ?? '');
      const target = await ctx.agent.call(tabId, 'focusForTyping', { ref });
      if (target.kind === 'special') {
        await ctx.agent.call(tabId, 'setValue', { ref, value });
      } else if (value.length) {
        // Replaces the selected content; handles any Unicode, emoji included.
        await send('Input.insertText', { text: value });
      } else {
        await pressKey(send, 'Delete');
      }
      if (submit) await pressKey(send, 'Enter');
      await settleAfterAction(tabId);
      return null;
    },

    async browser_select_option({ ref, values }) {
      const tabId = ctx.session.requireTab();
      await ctx.agent.call(tabId, 'selectOption', { ref, values });
      await settleAfterAction(tabId);
      return null;
    },

    async browser_press_key({ key }) {
      const tabId = ctx.session.requireTab();
      await pressKey(send, String(key ?? ''));
      await settleAfterAction(tabId);
      return null;
    },
  };
}
