// @ts-check
/**
 * Key presses through CDP Input.dispatchKeyEvent (trusted events).
 * Combos like "Control+Shift+ArrowLeft" or "Control++".
 * Every key that went down is released in `finally`, so an error in the
 * middle of a combo can never leave Control/Shift stuck (donor bug).
 */

export const MOD = Object.freeze({ Alt: 1, Control: 2, Meta: 4, Shift: 8 });

/** @typedef {{key: string, code: string, keyCode: number, text?: string, location?: number}} KeyDef */

/** @type {Record<string, KeyDef>} */
const NAMED = {
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Shift: { key: 'Shift', code: 'ShiftLeft', keyCode: 16, location: 1 },
  Control: { key: 'Control', code: 'ControlLeft', keyCode: 17, location: 1 },
  Alt: { key: 'Alt', code: 'AltLeft', keyCode: 18, location: 1 },
  Meta: { key: 'Meta', code: 'MetaLeft', keyCode: 91, location: 1 },
  Pause: { key: 'Pause', code: 'Pause', keyCode: 19 },
  CapsLock: { key: 'CapsLock', code: 'CapsLock', keyCode: 20 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  ' ': { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  PrintScreen: { key: 'PrintScreen', code: 'PrintScreen', keyCode: 44 },
  Insert: { key: 'Insert', code: 'Insert', keyCode: 45 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  ContextMenu: { key: 'ContextMenu', code: 'ContextMenu', keyCode: 93 },
  NumLock: { key: 'NumLock', code: 'NumLock', keyCode: 144 },
  ScrollLock: { key: 'ScrollLock', code: 'ScrollLock', keyCode: 145 },
};
for (let i = 1; i <= 12; i++) NAMED[`F${i}`] = { key: `F${i}`, code: `F${i}`, keyCode: 111 + i };

const ALIASES = {
  ctrl: 'Control', control: 'Control', controlormeta: 'Control', cmd: 'Meta', command: 'Meta', meta: 'Meta',
  win: 'Meta', super: 'Meta', option: 'Alt', alt: 'Alt', shift: 'Shift', esc: 'Escape', escape: 'Escape',
  return: 'Enter', enter: 'Enter', del: 'Delete', delete: 'Delete', space: ' ', spacebar: ' ', up: 'ArrowUp',
  down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', pgup: 'PageUp', pgdn: 'PageDown', ins: 'Insert',
  backspace: 'Backspace', tab: 'Tab', home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown',
  arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight', insert: 'Insert',
};

// US layout: char -> [code, keyCode, shifted]
const PUNCT = {
  '-': ['Minus', 189, false], _: ['Minus', 189, true], '=': ['Equal', 187, false], '+': ['Equal', 187, true],
  '[': ['BracketLeft', 219, false], '{': ['BracketLeft', 219, true], ']': ['BracketRight', 221, false],
  '}': ['BracketRight', 221, true], '\\': ['Backslash', 220, false], '|': ['Backslash', 220, true],
  ';': ['Semicolon', 186, false], ':': ['Semicolon', 186, true], "'": ['Quote', 222, false], '"': ['Quote', 222, true],
  ',': ['Comma', 188, false], '<': ['Comma', 188, true], '.': ['Period', 190, false], '>': ['Period', 190, true],
  '/': ['Slash', 191, false], '?': ['Slash', 191, true], '`': ['Backquote', 192, false], '~': ['Backquote', 192, true],
  '!': ['Digit1', 49, true], '@': ['Digit2', 50, true], '#': ['Digit3', 51, true], $: ['Digit4', 52, true],
  '%': ['Digit5', 53, true], '^': ['Digit6', 54, true], '&': ['Digit7', 55, true], '*': ['Digit8', 56, true],
  '(': ['Digit9', 57, true], ')': ['Digit0', 48, true],
};

/** @param {string} token @returns {KeyDef | null} */
export function resolveKey(token) {
  if (Object.prototype.hasOwnProperty.call(NAMED, token)) return NAMED[token];
  const alias = ALIASES[token.toLowerCase()];
  if (alias) return NAMED[alias];
  const chars = Array.from(token);
  if (chars.length !== 1) return null;
  const ch = chars[0];
  if (/^[a-z]$/i.test(ch)) return { key: ch, code: `Key${ch.toUpperCase()}`, keyCode: ch.toUpperCase().charCodeAt(0), text: ch };
  if (/^[0-9]$/.test(ch)) return { key: ch, code: `Digit${ch}`, keyCode: 48 + Number(ch), text: ch };
  if (PUNCT[ch]) return { key: ch, code: PUNCT[ch][0], keyCode: PUNCT[ch][1], text: ch };
  // Any other single Unicode character (ё, é, 🚀 ...): text only.
  return { key: ch, code: '', keyCode: 0, text: ch };
}

/**
 * "Control+Shift+a" -> {modifiers: [Control, Shift], key: a}
 * @param {string} combo
 */
export function parseCombo(combo) {
  if (typeof combo !== 'string' || combo === '') throw new Error('key must be a non-empty string');
  let tokens;
  if (combo === '+') tokens = ['+'];
  else if (combo.endsWith('++')) tokens = [...combo.slice(0, -2).split('+'), '+'];
  else tokens = combo.split('+');
  if (tokens.some((t) => t === '')) throw new Error(`Unknown key: "${combo}"`);
  const keyToken = tokens[tokens.length - 1];
  const modifiers = tokens.slice(0, -1).map((t) => {
    const def = resolveKey(t);
    if (!def || !(def.key in MOD)) throw new Error(`Unknown modifier: "${t}" (use Control, Shift, Alt or Meta)`);
    return def;
  });
  const key = resolveKey(keyToken);
  if (!key) throw new Error(`Unknown key: "${keyToken}"`);
  return { modifiers, key };
}

/** Shift + letter gives an upper-case letter, like a real keyboard. */
function applyShift(def, mask) {
  if (!(mask & MOD.Shift) || !def.text) return def;
  if (/^[a-z]$/.test(def.text)) return { ...def, key: def.text.toUpperCase(), text: def.text.toUpperCase() };
  return def;
}

/** @param {Record<string, unknown>} o */
const compact = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

/**
 * @param {(method: string, params: object) => Promise<unknown>} send CDP sender
 * @param {string} combo
 */
export async function pressKey(send, combo) {
  const { modifiers, key } = parseCombo(combo);
  let mask = 0;
  /** @type {KeyDef[]} */
  const down = [];
  let mainDown = null;
  /** @type {unknown} */
  let failure = null;
  try {
    for (const m of modifiers) {
      mask |= MOD[m.key];
      await send('Input.dispatchKeyEvent', compact({ type: 'rawKeyDown', modifiers: mask, key: m.key, code: m.code, windowsVirtualKeyCode: m.keyCode, location: m.location }));
      down.push(m);
    }
    if (key.key in MOD && !modifiers.length) {
      // A lone modifier press.
      mask |= MOD[key.key];
    }
    const def = applyShift(key, mask);
    const withText = !!def.text && !(mask & (MOD.Control | MOD.Alt | MOD.Meta));
    mainDown = def;
    await send('Input.dispatchKeyEvent', compact({
      type: withText ? 'keyDown' : 'rawKeyDown',
      modifiers: mask,
      key: def.key,
      code: def.code || undefined,
      windowsVirtualKeyCode: def.keyCode || undefined,
      text: withText ? def.text : undefined,
      unmodifiedText: withText ? def.text : undefined,
      location: def.location,
    }));
  } catch (error) {
    failure = error;
  } finally {
    const releaseErrors = [];
    if (mainDown) {
      try {
        await send('Input.dispatchKeyEvent', compact({ type: 'keyUp', modifiers: mask, key: mainDown.key, code: mainDown.code || undefined, windowsVirtualKeyCode: mainDown.keyCode || undefined, location: mainDown.location }));
      } catch (e) {
        releaseErrors.push(e);
      }
      if (mainDown.key in MOD) mask &= ~MOD[mainDown.key];
    }
    for (const m of down.reverse()) {
      mask &= ~MOD[m.key];
      try {
        await send('Input.dispatchKeyEvent', compact({ type: 'keyUp', modifiers: mask, key: m.key, code: m.code, windowsVirtualKeyCode: m.keyCode, location: m.location }));
      } catch (e) {
        releaseErrors.push(e);
      }
    }
    if (failure) throw failure;
    if (releaseErrors.length) throw releaseErrors[0];
  }
}
