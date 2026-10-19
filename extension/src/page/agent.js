// Browser Control page agent.
// Classic script (not a module): injected with chrome.scripting.executeScript
// into the extension's ISOLATED world of the connected tab's main frame.
// The site cannot see or tamper with it. Re-injection is a no-op.
//
// Snapshot format follows Playwright's aria snapshot, as the donor did:
//   - button "Save" [ref=s3e12]
//   - textbox "Email" [ref=s3e13]: user@example.com
// Refs are s<generation>e<number>; the generation comes from the service
// worker, so refs from an older snapshot (or another page) are always stale.
'use strict';

(function installBrowserControlAgent() {
  const AGENT_VERSION = '1.0.0';
  const g = /** @type {any} */ (globalThis);
  if (g.__browserControl && g.__browserControl.version === AGENT_VERSION) return;

  const MAX_NODES = 5000;
  const MAX_NAME = 200;
  const MAX_TEXT = 400;
  const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'head', 'meta', 'link', 'title', 'base']);
  const NAME_FROM_CONTENT = new Set([
    'button', 'cell', 'checkbox', 'columnheader', 'gridcell', 'heading', 'link', 'menuitem',
    'menuitemcheckbox', 'menuitemradio', 'option', 'radio', 'row', 'rowheader', 'switch', 'tab',
    'tooltip', 'treeitem',
  ]);
  const VALUE_ROLES = new Set(['textbox', 'searchbox', 'spinbutton', 'combobox', 'slider']);
  const BLOCK_DISPLAY = /^(block|flex|grid|list-item|table|table-row|table-cell|flow-root)$/;
  const SPECIAL_INPUTS = new Set(['date', 'time', 'datetime-local', 'month', 'week', 'color', 'range']);
  const TEXT_INPUTS = new Set(['', 'text', 'search', 'email', 'url', 'tel', 'password', 'number']);

  /** @type {{generation: number, elements: Map<number, Element>} | null} */
  let current = null;

  // ------------------------------------------------------------ roles ---

  function inSectioning(el) {
    for (let p = el.parentElement; p; p = p.parentElement) {
      if (/^(article|aside|main|nav|section)$/.test(p.localName)) return true;
    }
    return false;
  }

  function inputRole(el) {
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    switch (type) {
      case 'hidden': return null;
      case 'button': case 'submit': case 'reset': case 'image': case 'file': return 'button';
      case 'checkbox': return el.getAttribute('role') === 'switch' ? 'switch' : 'checkbox';
      case 'radio': return 'radio';
      case 'range': return 'slider';
      case 'number': return 'spinbutton';
      case 'search': return el.hasAttribute('list') ? 'combobox' : 'searchbox';
      default: return el.hasAttribute('list') && TEXT_INPUTS.has(type) ? 'combobox' : 'textbox';
    }
  }

  function implicitRole(el) {
    const tag = el.localName;
    switch (tag) {
      case 'a': case 'area': return el.hasAttribute('href') ? 'link' : null;
      case 'article': return 'article';
      case 'aside': return 'complementary';
      case 'blockquote': return 'blockquote';
      case 'button': return 'button';
      case 'caption': return 'caption';
      case 'code': return 'code';
      case 'datalist': return 'listbox';
      case 'dd': return 'definition';
      case 'details': return 'group';
      case 'dialog': return 'dialog';
      case 'dt': return 'term';
      case 'fieldset': return 'group';
      case 'figure': return 'figure';
      case 'footer': return inSectioning(el) ? null : 'contentinfo';
      case 'form': return 'form';
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': return 'heading';
      case 'header': return inSectioning(el) ? null : 'banner';
      case 'hr': return 'separator';
      case 'iframe': return 'iframe';
      case 'img': return el.getAttribute('alt') === '' && !el.hasAttribute('title') ? null : 'img';
      case 'input': return inputRole(el);
      case 'li': return 'listitem';
      case 'main': return 'main';
      case 'menu': case 'ol': case 'ul': return 'list';
      case 'meter': return 'meter';
      case 'nav': return 'navigation';
      case 'optgroup': return 'group';
      case 'option': return 'option';
      case 'output': return 'status';
      case 'p': return 'paragraph';
      case 'progress': return 'progressbar';
      case 'section': return el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby') ? 'region' : null;
      case 'select': return el.multiple || el.size > 1 ? 'listbox' : 'combobox';
      case 'summary': return 'button';
      case 'svg': return el.querySelector(':scope > title') || el.hasAttribute('aria-label') ? 'img' : null;
      case 'table': return 'table';
      case 'tbody': case 'tfoot': case 'thead': return 'rowgroup';
      case 'td': return 'cell';
      case 'textarea': return 'textbox';
      case 'th': return el.closest('thead') || el.getAttribute('scope') === 'col' ? 'columnheader' : 'rowheader';
      case 'tr': return 'row';
      default:
        if (el.isContentEditable && el.getAttribute('contenteditable') !== null) {
          const parent = el.parentElement;
          if (!parent || !parent.isContentEditable) return 'textbox';
        }
        return null;
    }
  }

  function roleOf(el) {
    const explicit = (el.getAttribute('role') || '').trim().split(/\s+/)[0].toLowerCase();
    if (explicit && explicit !== 'presentation' && explicit !== 'none' && explicit !== 'generic') return explicit;
    if (explicit === 'presentation' || explicit === 'none') {
      return el.tabIndex >= 0 && el.hasAttribute('tabindex') ? implicitRole(el) : null;
    }
    return implicitRole(el);
  }

  // ------------------------------------------------------------ names ---

  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

  function rootOf(el) {
    const root = el.getRootNode();
    return root && root.getElementById ? root : document;
  }

  function visibleText(el) {
    let text = norm(el.innerText !== undefined ? el.innerText : el.textContent);
    if (!text) {
      const pieces = [];
      el.querySelectorAll('img[alt], [aria-label], svg title').forEach((n) => {
        pieces.push(n.localName === 'title' ? n.textContent : n.getAttribute('alt') || n.getAttribute('aria-label'));
      });
      text = norm(pieces.join(' '));
    }
    return text;
  }

  function labelText(el) {
    const labels = el.labels ? Array.from(el.labels) : [];
    const parts = labels.map((label) => {
      const copy = label.cloneNode(true);
      copy.querySelectorAll('input, select, textarea, button').forEach((c) => c.remove());
      return norm(copy.textContent);
    });
    return norm(parts.join(' '));
  }

  function accessibleName(el, role) {
    const labelledby = el.getAttribute('aria-labelledby');
    if (labelledby) {
      const root = rootOf(el);
      const text = norm(labelledby.split(/\s+/).map((id) => {
        const target = root.getElementById(id) || document.getElementById(id);
        return target ? visibleText(target) || norm(target.textContent) : '';
      }).join(' '));
      if (text) return text;
    }
    const ariaLabel = norm(el.getAttribute('aria-label'));
    if (ariaLabel) return ariaLabel;
    const tag = el.localName;
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      const type = (el.getAttribute('type') || '').toLowerCase();
      if (tag === 'input' && /^(button|submit|reset)$/.test(type)) {
        return norm(el.value) || (type === 'submit' ? 'Submit' : type === 'reset' ? 'Reset' : '');
      }
      if (tag === 'input' && type === 'image') return norm(el.getAttribute('alt')) || 'Submit';
      const fromLabel = labelText(el);
      if (fromLabel) return fromLabel;
      const placeholder = norm(el.getAttribute('placeholder'));
      if (placeholder) return placeholder;
    }
    if (tag === 'img' || tag === 'area') {
      const alt = norm(el.getAttribute('alt'));
      if (alt) return alt;
    }
    if (tag === 'svg') {
      const title = el.querySelector(':scope > title');
      if (title) return norm(title.textContent);
    }
    if (tag === 'fieldset') {
      const legend = el.querySelector(':scope > legend');
      if (legend) return norm(legend.textContent);
    }
    if (tag === 'table') {
      const caption = el.querySelector(':scope > caption');
      if (caption) return norm(caption.textContent);
    }
    if (tag === 'figure') {
      const cap = el.querySelector(':scope > figcaption');
      if (cap) return norm(cap.textContent);
    }
    if (NAME_FROM_CONTENT.has(role) || tag === 'summary') {
      const text = visibleText(el);
      if (text) return text;
    }
    return norm(el.getAttribute('title'));
  }

  // ------------------------------------------------------------ state ---

  function propsOf(el, role) {
    const props = [];
    if (role === 'heading') {
      const level = el.getAttribute('aria-level') || (/^h([1-6])$/.exec(el.localName) || [])[1];
      if (level) props.push(`level=${level}`);
    }
    if (role === 'checkbox' || role === 'radio' || role === 'switch' || role === 'menuitemcheckbox' || role === 'menuitemradio') {
      const aria = el.getAttribute('aria-checked');
      if (el.indeterminate || aria === 'mixed') props.push('checked=mixed');
      else if (el.checked === true || aria === 'true') props.push('checked');
    }
    if (el.disabled === true || el.getAttribute('aria-disabled') === 'true') props.push('disabled');
    const expanded = el.getAttribute('aria-expanded');
    if (expanded === 'true' || (el.localName === 'details' && el.open)) props.push('expanded');
    const pressed = el.getAttribute('aria-pressed');
    if (pressed === 'true') props.push('pressed');
    else if (pressed === 'mixed') props.push('pressed=mixed');
    if (el.selected === true || el.getAttribute('aria-selected') === 'true') props.push('selected');
    if (el.required === true || el.getAttribute('aria-required') === 'true') props.push('required');
    if (el === deepActiveElement()) props.push('active');
    return props;
  }

  function valueOf(el, role) {
    if (!VALUE_ROLES.has(role) && role !== 'progressbar' && role !== 'meter') return null;
    const tag = el.localName;
    if (tag === 'select') {
      const selected = Array.from(el.selectedOptions || []).map((o) => norm(o.textContent));
      return selected.join(', ');
    }
    if (tag === 'input' || tag === 'textarea') {
      if ((el.getAttribute('type') || '').toLowerCase() === 'password') return el.value ? '•'.repeat(Math.min(el.value.length, 12)) : '';
      return el.value;
    }
    if (tag === 'progress' || tag === 'meter') return String(el.value);
    const now = el.getAttribute('aria-valuetext') || el.getAttribute('aria-valuenow');
    if (now) return now;
    if (el.isContentEditable) return norm(el.innerText);
    return null;
  }

  function deepActiveElement() {
    let a = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    return a;
  }

  // ------------------------------------------------------------ tree ---

  /**
   * @typedef {{role: string, name: string, props: string[], ref: string, value: string | null,
   *            url: string | null, children: Array<Node | string>}} Node
   */

  function buildTree(generation) {
    const elements = new Map();
    let counter = 0;
    let truncated = false;

    function childNodesOf(node) {
      if (node.shadowRoot) return Array.from(node.shadowRoot.childNodes);
      if (node.localName === 'slot') {
        const assigned = node.assignedNodes({ flatten: true });
        return assigned.length ? assigned : Array.from(node.childNodes);
      }
      return Array.from(node.childNodes);
    }

    function visitChildren(node, out, parentCursor) {
      for (const child of childNodesOf(node)) visit(child, out, parentCursor);
    }

    function visit(node, out, parentCursor) {
      if (truncated) return;
      if (node.nodeType === Node.TEXT_NODE) {
        const parent = node.parentElement;
        if (parent) {
          const style = getComputedStyle(parent);
          if (style.visibility === 'hidden' || style.visibility === 'collapse') return;
        }
        const text = node.data.replace(/\s+/g, ' ');
        if (text.trim()) out.push(text);
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const el = /** @type {Element} */ (node);
      const tag = el.localName;
      if (SKIP_TAGS.has(tag)) return;
      if (el.getAttribute('aria-hidden') === 'true') return;
      const style = getComputedStyle(el);
      if (style.display === 'none') return;
      if (tag === 'input' && (el.getAttribute('type') || '').toLowerCase() === 'hidden') return;
      const visibleSelf = style.visibility !== 'hidden' && style.visibility !== 'collapse';
      const role = visibleSelf ? roleOf(el) : null;
      const cursor = style.cursor;
      const clickable = !role && visibleSelf && cursor === 'pointer' && parentCursor !== 'pointer' && tag !== 'label';
      const block = BLOCK_DISPLAY.test(style.display);

      if (!role && !clickable) {
        if (block) out.push(' ');
        if (tag === 'svg' || tag === 'canvas' || tag === 'video' || tag === 'audio') return;
        visitChildren(el, out, cursor);
        if (block) out.push(' ');
        if (tag === 'br') out.push(' ');
        return;
      }

      counter += 1;
      if (counter > MAX_NODES) {
        truncated = true;
        return;
      }
      elements.set(counter, el);
      const finalRole = role || 'generic';
      /** @type {Node} */
      const item = {
        role: finalRole,
        name: role ? clip(accessibleName(el, role), MAX_NAME) : '',
        props: role ? propsOf(el, role) : [],
        ref: `s${generation}e${counter}`,
        value: role ? valueOf(el, role) : null,
        url: role === 'link' ? el.getAttribute('href') : null,
        children: [],
      };
      if (clickable) item.props.push('cursor=pointer');
      if (finalRole === 'img' || finalRole === 'iframe' || tag === 'input' || tag === 'textarea') {
        // leaf: nothing useful inside
      } else if (tag === 'select') {
        visitChildren(el, item.children, cursor);
      } else {
        visitChildren(el, item.children, cursor);
      }
      if (finalRole === 'iframe') item.name = item.name || norm(el.getAttribute('title') || el.getAttribute('src'));
      if (block) out.push(' ');
      out.push(item);
      if (block) out.push(' ');
    }

    const out = [];
    if (document.body) visitChildren(document.body, out, '');
    current = { generation, elements };
    return { items: out, truncated, count: counter };
  }

  /** Merge adjacent strings, collapse whitespace, drop empties. */
  function normalizeChildren(children) {
    const result = [];
    let text = '';
    const flush = () => {
      const t = norm(text);
      if (t) result.push(t);
      text = '';
    };
    for (const child of children) {
      if (typeof child === 'string') text += child;
      else {
        flush();
        result.push(child);
      }
    }
    flush();
    return result;
  }

  const YAML_UNSAFE = /^[\s\-?:,[\]{}#&*!|>'"%@`]|: | #|[\n\r\t]|\s$|^(true|false|null|yes|no|on|off|~|-?\d[\d.,e+-]*)$/i;
  function yamlText(s) {
    const t = clip(String(s), MAX_TEXT);
    return YAML_UNSAFE.test(t) || t === '' ? JSON.stringify(t) : t;
  }

  function render(items, depth, lines) {
    const pad = '  '.repeat(depth);
    for (const it of normalizeChildren(items)) {
      if (typeof it === 'string') {
        lines.push(`${pad}- text: ${yamlText(it)}`);
        continue;
      }
      let head = `${pad}- ${it.role}`;
      if (it.name) head += ` ${JSON.stringify(it.name)}`;
      for (const p of it.props) head += ` [${p}]`;
      head += ` [ref=${it.ref}]`;
      let kids = normalizeChildren(it.children);
      // Name computed from content already shows the text: drop text-only kids.
      if (it.name && kids.every((k) => typeof k === 'string') && norm(kids.join(' ')) === it.name) kids = [];
      if (it.name && kids.length === 1 && typeof kids[0] === 'string' && it.name.includes(kids[0])) kids = [];
      const extra = it.url !== null && it.url !== undefined ? [`${pad}  - /url: ${yamlText(it.url)}`] : [];
      if (!kids.length && !extra.length) {
        lines.push(it.value !== null && it.value !== undefined && it.value !== '' ? `${head}: ${yamlText(it.value)}` : head);
      } else if (!extra.length && kids.length === 1 && typeof kids[0] === 'string' && (it.value === null || it.value === '')) {
        lines.push(`${head}: ${yamlText(kids[0])}`);
      } else {
        lines.push(`${head}:`);
        if (it.value !== null && it.value !== undefined && it.value !== '') lines.push(`${pad}  - value: ${yamlText(it.value)}`);
        lines.push(...extra);
        render(kids, depth + 1, lines);
      }
    }
    return lines;
  }

  // ------------------------------------------------------------ refs ---

  function resolve(ref) {
    const raw = String(ref || '').trim().replace(/^\[?ref=/, '').replace(/\]$/, '');
    const m = /^s(\d+)e(\d+)$/.exec(raw);
    if (!m) throw new Error('Invalid aria-ref selector, should be of form s<number>e<number>');
    if (!current) throw new Error('No snapshot found. Please generate an aria snapshot before trying again.');
    const generation = Number(m[1]);
    const index = Number(m[2]);
    if (generation !== current.generation) {
      throw new Error(`Stale aria-ref, expected s${current.generation}e${index}, got ${raw}. Please regenerate an aria snapshot before trying again.`);
    }
    const el = current.elements.get(index);
    if (!el || !el.isConnected) throw new Error(`Element with aria-ref ${raw} not found`);
    return el;
  }

  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  function inViewport(rect) {
    return rect.top >= 0 && rect.left >= 0 && rect.bottom <= innerHeight && rect.right <= innerWidth;
  }

  function describe(el) {
    if (!el) return null;
    const id = el.id ? `#${el.id}` : '';
    const cls = typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}` : '';
    return `${el.localName}${id}${cls}`;
  }

  function deepElementFromPoint(x, y) {
    let el = document.elementFromPoint(x, y);
    while (el && el.shadowRoot) {
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  }

  function contains(outer, inner) {
    for (let n = inner; n; n = n.parentNode || n.host) if (n === outer) return true;
    return false;
  }

  // ------------------------------------------------------------ commands ---

  const commands = {
    ping: () => ({ version: AGENT_VERSION, url: location.href }),

    snapshot({ generation }) {
      const tree = buildTree(Number(generation) || 1);
      const lines = render(tree.items, 0, []);
      if (tree.truncated) lines.push(`- text: "… snapshot truncated after ${MAX_NODES} elements"`);
      return lines.join('\n');
    },

    /** Scroll into view and return the click point in CSS px of the viewport. */
    async point({ ref, scroll = true }) {
      const el = resolve(ref);
      let rect = el.getBoundingClientRect();
      if (scroll && !inViewport(rect)) {
        el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        await delay(60);
        rect = el.getBoundingClientRect();
      }
      const box = el.getClientRects()[0] || rect;
      if (box.width < 1 || box.height < 1) return { fallback: true, reason: 'element has no visible box' };
      const x = Math.min(Math.max(box.left + box.width / 2, 0), innerWidth - 1);
      const y = Math.min(Math.max(box.top + box.height / 2, 0), innerHeight - 1);
      const hit = deepElementFromPoint(x, y);
      const covered = hit && !contains(el, hit) && !contains(hit, el) ? describe(hit) : null;
      return { x, y, covered };
    },

    domClick({ ref }) {
      const el = resolve(ref);
      el.click();
      return true;
    },

    /** Focus an editable element and select its current content (fill semantics). */
    focusForTyping({ ref }) {
      let el = resolve(ref);
      if (el.localName === 'label' && el.control) el = el.control;
      const tag = el.localName;
      if (tag === 'input') {
        const type = (el.getAttribute('type') || 'text').toLowerCase();
        if (el.disabled || el.readOnly) throw new Error('Element is disabled or read-only');
        if (SPECIAL_INPUTS.has(type)) return { kind: 'special', type };
        if (!TEXT_INPUTS.has(type)) throw new Error(`Input of type "${type}" does not accept typed text`);
        el.focus();
        try { el.select(); } catch { /* some types do not support selection */ }
        return { kind: 'input', type };
      }
      if (tag === 'textarea') {
        if (el.disabled || el.readOnly) throw new Error('Element is disabled or read-only');
        el.focus();
        el.select();
        return { kind: 'textarea' };
      }
      if (el.isContentEditable) {
        el.focus();
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        return { kind: 'contenteditable' };
      }
      throw new Error('Element is not an <input>, <textarea> or contenteditable element');
    },

    /** Value setter for date/color/range inputs that cannot be typed into. */
    setValue({ ref, value }) {
      const el = resolve(ref);
      const proto = el.localName === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      el.focus();
      setter.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      if (el.value !== value) throw new Error(`The element rejected the value "${value}" (it now holds "${el.value}")`);
      return el.value;
    },

    selectOption({ ref, values }) {
      const el = resolve(ref);
      if (el.localName !== 'select') throw new Error(`Element is not a <select> element: ${ref}`);
      const wanted = Array.isArray(values) ? values.map(String) : [String(values)];
      if (!wanted.length) throw new Error('values must contain at least one value');
      const list = el.multiple ? wanted : [wanted[0]];
      const options = Array.from(el.options);
      const picked = list.map((v) => {
        const found = options.find((o) => o.value === v) || options.find((o) => norm(o.textContent) === norm(v)) || options.find((o) => norm(o.label) === norm(v));
        if (!found) throw new Error(`Unable to find option for value: ${v}`);
        if (found.disabled) throw new Error(`Option is disabled: ${v}`);
        return found;
      });
      el.focus();
      for (const o of options) o.selected = picked.includes(o);
      el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return picked.map((o) => o.value);
    },

    /** Resolve when the DOM has been quiet for quietMs (or maxMs passes). */
    waitForStable({ quietMs = 300, maxMs = 2000 } = {}) {
      return new Promise((resolveWait) => {
        let timer = setTimeout(done, quietMs);
        const hard = setTimeout(done, maxMs);
        const observer = new MutationObserver(() => {
          clearTimeout(timer);
          timer = setTimeout(done, quietMs);
        });
        observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
        function done() {
          observer.disconnect();
          clearTimeout(timer);
          clearTimeout(hard);
          resolveWait(true);
        }
      });
    },
  };

  async function call(name, args) {
    try {
      if (!Object.prototype.hasOwnProperty.call(commands, name)) throw new Error(`Unknown page command: ${name}`);
      const value = await commands[name](args || {});
      return { ok: true, value };
    } catch (error) {
      return { ok: false, error: error && error.message ? error.message : String(error) };
    }
  }

  g.__browserControl = Object.freeze({
    version: AGENT_VERSION,
    call,
    // exposed for unit tests only (tests/agent-render.test.mjs)
    _internals: { render, normalizeChildren, yamlText, implicitRole },
  });
})();
