/*
 * Audit Autofill – reading and driving the audit edit page.
 *
 * scan()      finds every audit item (a row with an edit button), groups the
 *             rows into section cards and returns them in reading order.
 * markGreen() opens one item's dialog, picks the first (green) option, and presses
 *             Submit. Nothing else in the dialog is touched (recommendations,
 *             additional details), unless a default details text is set.
 *
 * The page's markup isn't hard-coded: items are found from their edit (pencil)
 * buttons, sections from how the rows are nested, so small template changes
 * don't break it.
 */
(function (root) {
  'use strict';

  const HOST_ID = 'bobcares-audit-autofill-host';
  const EDIT_ICON = [
    '[class*="fa-edit"]',
    '[class*="fa-pencil"]',
    '[class*="fa-pen-"]',
    '.fa-pen',
    '[class*="mdi-pencil"]',
    '[class*="mdi-square-edit"]',
    '[class*="ni-ruler-pencil"]',
    '[class*="feather-edit"]',
    '[class*="bx-edit"]',
    '[class*="ti-pencil"]',
    '[class*="la-edit"]',
    '[class*="la-pencil"]',
  ].join(',');
  const CLICKABLE = 'a, button, [role="button"], [data-toggle], [data-bs-toggle], [onclick]';
  const NOT_CONTENT = 'nav, aside, .navbar, .sidenav, .sidebar, .main-sidebar, .modal, [role="dialog"], #' + HOST_ID;
  const DIALOG = '.modal, [role="dialog"], .swal2-popup, .ui-dialog, .bootbox';

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const norm = (s) => clean(s).toLowerCase();

  function visible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && parseFloat(cs.opacity || '1') > 0.05;
  }

  async function waitFor(fn, timeout, every) {
    const end = Date.now() + timeout;
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() > end) return null;
      await sleep(every || 100);
    }
  }

  const byDomOrder = (a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);

  function lca(a, b) {
    const seen = new Set();
    for (let e = a; e; e = e.parentElement) seen.add(e);
    for (let e = b; e; e = e.parentElement) if (seen.has(e)) return e;
    return null;
  }

  function depth(el) {
    let d = 0;
    for (let e = el; e; e = e.parentElement) d++;
    return d;
  }

  // ------------------------------------------------------------- colours

  function parseColor(css) {
    const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?/.exec(css || '');
    if (!m) return null;
    let a = m[4] === undefined ? 1 : parseFloat(m[4]);
    if (m[4] && m[4].endsWith('%')) a /= 100;
    return { r: +m[1], g: +m[2], b: +m[3], a };
  }

  function colorName(css) {
    const c = parseColor(css);
    if (!c || c.a < 0.3) return null;
    const max = Math.max(c.r, c.g, c.b);
    const min = Math.min(c.r, c.g, c.b);
    const d = max - min;
    const v = max / 255;
    const s = max ? d / max : 0;
    if (s < 0.2) return v >= 0.35 && v <= 0.85 ? 'grey' : null;
    let h;
    if (max === c.r) h = 60 * (((c.g - c.b) / d) % 6);
    else if (max === c.g) h = 60 * ((c.b - c.r) / d + 2);
    else h = 60 * ((c.r - c.g) / d + 4);
    if (h < 0) h += 360;
    if (h >= 80 && h <= 180) return 'green';
    if (h >= 35 && h < 70 && s >= 0.45) return 'yellow';
    if (h <= 15 || h >= 340) return 'red';
    return null;
  }

  const CLASS_STATE = [
    [/(^|[-_ ])(success|green|active|enabled?|done)([-_ ]|$)/i, 'green'],
    [/(^|[-_ ])(warning|yellow|pending|not-?done)([-_ ]|$)/i, 'yellow'],
    [/(^|[-_ ])(danger|red|inactive|disabled?)([-_ ]|$)/i, 'red'],
    [/(^|[-_ ])(secondary|muted|grey|gray|na)([-_ ]|$)/i, 'grey'],
  ];

  // Current colour of an item on the page (the dot left of its label):
  // 'green' | 'yellow' | 'red' | 'grey' | 'unknown'.
  function rowState(row, trigger) {
    const parts = [...row.querySelectorAll('*')].filter((e) => !trigger.contains(e) && !e.contains(trigger) && !e.closest(DIALOG));
    // Small marks without text: dots, icons, badges.
    for (const e of parts) {
      const r = e.getBoundingClientRect();
      if (!r.width || r.width > 28 || r.height > 28 || clean(e.textContent).length > 2) continue;
      const cls = typeof e.className === 'string' ? e.className : e.getAttribute('class') || '';
      for (const [re, state] of CLASS_STATE) if (re.test(cls.replace(/\s+/g, ' '))) return state;
      const cs = getComputedStyle(e);
      const name = colorName(cs.backgroundColor) || colorName(cs.color) || colorName(cs.fill) || colorName(cs.borderTopColor);
      if (name) return name;
    }
    // Bullets drawn with ::before / ::marker.
    for (const e of [row, ...parts]) {
      for (const pseudo of ['::before', '::marker']) {
        if (pseudo === '::marker' && getComputedStyle(e).display !== 'list-item') continue;
        const cs = getComputedStyle(e, pseudo);
        if (pseudo === '::before' && (!cs.content || cs.content === 'none' || cs.content === 'normal')) continue;
        const name = colorName(cs.backgroundColor) || colorName(cs.color);
        if (name && name !== 'grey') return name;
      }
    }
    return 'unknown';
  }

  // ------------------------------------------------------------- scanning

  function findTriggers() {
    let list = [...document.querySelectorAll(EDIT_ICON)].map((i) => i.closest(CLICKABLE) || i);
    if (!list.length) list = [...document.querySelectorAll('[data-toggle="modal"], [data-bs-toggle="modal"]')];
    list = [...new Set(list)].filter((el) => visible(el) && !el.closest(NOT_CONTENT));
    list = list.filter((el) => !list.some((o) => o !== el && o.contains(el)));
    return list.sort(byDomOrder);
  }

  // The row of a trigger: its highest ancestor that holds no other trigger.
  function rowOf(trigger, triggers) {
    let el = trigger;
    while (el.parentElement && el.parentElement !== document.body) {
      const p = el.parentElement;
      if (triggers.some((o) => o !== trigger && p.contains(o))) break;
      el = p;
    }
    return el;
  }

  function labelOf(row, trigger) {
    let text = row.innerText || row.textContent || '';
    const own = clean(trigger.innerText);
    if (own) text = text.replace(own, '');
    return text.split('\n').map(clean).filter(Boolean)[0] || '';
  }

  // First visible text in a section container that isn't part of an item.
  function headerOf(container, rows) {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = clean(n.nodeValue);
      if (!t) continue;
      const p = n.parentElement;
      if (!p || rows.some((r) => r.contains(p))) continue;
      if (p.closest('script, style, template, ' + DIALOG) || !visible(p)) continue;
      return t;
    }
    return '';
  }

  /**
   * @returns {{ sections: [{ name, el, items: [{ label, row, trigger, state }] }], items: number }}
   */
  // Nesting depth plus the tag path from a row down to its edit button, e.g. "9:LI>BUTTON".
  function shape(row, trigger) {
    const path = [];
    for (let e = trigger; e && e !== row; e = e.parentElement) path.unshift(e.tagName);
    return depth(row) + ':' + [row.tagName, ...path].join('>');
  }

  function scan() {
    const triggers = findTriggers();
    let rows = triggers.map((t) => ({ trigger: t, row: rowOf(t, triggers) }));
    // Audit rows all look alike; drop odd ones out (an edit button elsewhere on
    // the page would otherwise become an extra section and shift the order).
    if (rows.length >= 4) {
      const count = new Map();
      rows.forEach((r) => count.set((r.shape = shape(r.row, r.trigger)), (count.get(r.shape) || 0) + 1));
      const [common, n] = [...count].sort((a, b) => b[1] - a[1])[0];
      if (n >= rows.length * 0.6) rows = rows.filter((r) => r.shape === common);
    }
    if (!rows.length) return { sections: [], items: 0 };

    // Rows of one card share a deep common ancestor (the list); consecutive
    // rows of different cards only meet higher up (the grid).
    const groups = [[rows[0]]];
    if (rows.length > 1) {
      const d = [];
      for (let i = 1; i < rows.length; i++) d.push(depth(lca(rows[i - 1].row, rows[i].row)));
      const deepest = Math.max(...d);
      for (let i = 1; i < rows.length; i++) {
        if (d[i - 1] < deepest) groups.push([]);
        groups[groups.length - 1].push(rows[i]);
      }
    }

    const sections = groups.map((g) => {
      const els = g.map((r) => r.row);
      let box = els.length > 1 ? els.reduce(lca) : els[0].parentElement;
      const others = rows.filter((r) => !g.includes(r)).map((r) => r.row);
      while (box.parentElement && box.parentElement !== document.body && !others.some((o) => box.parentElement.contains(o))) {
        box = box.parentElement;
      }
      return {
        name: headerOf(box, els) || 'Section',
        el: box,
        items: g.map((r) => ({ label: labelOf(r.row, r.trigger), row: r.row, trigger: r.trigger, state: rowState(r.row, r.trigger) })),
      };
    });

    // Reading order (top to bottom, then left to right), like the screenshot.
    const pos = new Map(sections.map((s) => [s, s.el.getBoundingClientRect()]));
    sections.sort((a, b) => pos.get(a).top - pos.get(b).top);
    let line = -1;
    let lineTop = -Infinity;
    for (const s of sections) {
      if (pos.get(s).top - lineTop > 20) {
        line++;
        lineTop = pos.get(s).top;
      }
      s.line = line;
    }
    sections.sort((a, b) => a.line - b.line || pos.get(a).left - pos.get(b).left);
    sections.forEach((s) => delete s.line);
    return { sections, items: rows.length };
  }

  // Find an item again after the page re-rendered or reloaded.
  function locate(page, ref) {
    const sec = page.sections[ref.s];
    if (sec && sec.items[ref.i] && norm(sec.items[ref.i].label) === norm(ref.label)) return sec.items[ref.i];
    const named = page.sections.filter((s) => norm(s.name) === norm(ref.section));
    for (const s of named) {
      const hit = s.items.filter((it) => norm(it.label) === norm(ref.label));
      if (hit.length === 1) return hit[0];
    }
    return null;
  }

  // ------------------------------------------------------------- dialog

  function openDialogs() {
    const list = [...document.querySelectorAll(DIALOG)].filter((d) => visible(d) && !d.closest('#' + HOST_ID));
    return list.filter((d) => !list.some((o) => o !== d && o.contains(d)));
  }

  function openDialog(except) {
    const list = openDialogs().filter((d) => !(except && except.includes(d)));
    return list[list.length - 1] || null;
  }

  function optionText(input, scope) {
    if (input.id) {
      const l = scope.querySelector('label[for="' + CSS.escape(input.id) + '"]');
      if (l && clean(l.innerText || l.textContent)) return clean(l.innerText || l.textContent);
    }
    const wrap = input.closest('label');
    if (wrap && clean(wrap.innerText || wrap.textContent)) return clean(wrap.innerText || wrap.textContent);
    for (let n = input.nextSibling; n; n = n.nextSibling) {
      const t = clean(n.textContent);
      if (t) return t.split(/\s{2,}|\n/)[0];
    }
    return clean(input.value);
  }

  function isRecommendation(group, dialog) {
    if (/recomm|suggest/i.test(group.name)) return true;
    const first = group.options[0].input;
    for (let e = first.parentElement; e && e !== dialog; e = e.parentElement) {
      const others = [...e.querySelectorAll('input[type=radio]')].some((i) => !group.options.some((o) => o.input === i));
      if (others) break;
      if (/recommend/i.test(e.textContent || '')) return true;
    }
    return false;
  }

  // Pick the green option of the dialog's status question: always its FIRST
  // option. Every section words it differently ("Active", "Good", "No Malwares",
  // "All updates installed", …), but the green one always comes first.
  // The "Any recommendations?" question is never touched.
  function chooseGreen(dialog) {
    const radios = [...dialog.querySelectorAll('input[type=radio]')].filter((i) => !i.disabled);
    const groups = [];
    for (const input of radios) {
      const name = input.name || '';
      let g = name && groups.find((x) => x.name === name);
      if (!g) {
        g = { name, options: [] };
        groups.push(g);
      }
      g.options.push({ input, text: optionText(input, dialog) });
    }
    const status = groups.find((g) => !isRecommendation(g, dialog));
    if (status) {
      const opt = status.options[0];
      if (!opt.input.checked) opt.input.click();
      if (!opt.input.checked) {
        opt.input.checked = true;
        opt.input.dispatchEvent(new Event('input', { bubbles: true }));
        opt.input.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return { ok: true, picked: opt.text };
    }
    for (const sel of dialog.querySelectorAll('select')) {
      if (sel.disabled || /recomm/i.test(sel.name || '')) continue;
      const opt = [...sel.options].find((o) => o.value !== '' && !o.disabled);
      if (!opt) continue;
      sel.value = opt.value;
      sel.dispatchEvent(new Event('input', { bubbles: true }));
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, picked: clean(opt.text) };
    }
    return { ok: false, msg: 'no status options in the dialog' };
  }

  function fillDetails(dialog, text) {
    if (!text) return;
    const area = [...dialog.querySelectorAll('textarea')].find((t) => visible(t) && !t.disabled && !t.readOnly);
    if (!area || clean(area.value)) return;
    area.value = text;
    area.dispatchEvent(new Event('input', { bubbles: true }));
    area.dispatchEvent(new Event('change', { bubbles: true }));
  }

  const buttonText = (b) => clean(b.innerText || b.value || b.getAttribute('aria-label') || '');

  function submitButton(dialog) {
    const btns = [...dialog.querySelectorAll('button, input[type=submit], input[type=button], a.btn')].filter(visible);
    const no = /cancel|close|dismiss/i;
    return (
      btns.find((b) => /^(submit|save|save changes|update|ok|done)$/i.test(buttonText(b))) ||
      btns.find((b) => b.type === 'submit' && !no.test(buttonText(b))) ||
      btns.find((b) => /submit|save|update/i.test(buttonText(b)) && !no.test(buttonText(b))) ||
      null
    );
  }

  function closeDialog(dialog) {
    const btns = [...dialog.querySelectorAll('button, a, [data-dismiss], [data-bs-dismiss]')].filter(visible);
    const b =
      btns.find((x) => /^cancel$/i.test(buttonText(x))) ||
      btns.find((x) => x.matches('[data-dismiss="modal"], [data-bs-dismiss="modal"], .close, .btn-close')) ||
      btns.find((x) => /cancel|close/i.test(buttonText(x)));
    if (b) b.click();
    else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
  }

  function dialogErrors(dialog) {
    return [...dialog.querySelectorAll('.invalid-feedback, .text-danger, .alert-danger, .error, .help-block, .parsley-errors-list')]
      .filter(visible)
      .map((e) => clean(e.innerText))
      .filter(Boolean)
      .join(' ');
  }

  /**
   * Open the item's dialog, choose the green option and submit.
   * opts: { details: string, dryRun: boolean, labels: Set<string> (all item labels, lower case),
   *         beforeSubmit: async fn, return false to cancel instead of submitting }
   * Resolves { ok, msg }. When the form reloads the page, it never resolves:
   * the content script picks the job up again after the reload.
   */
  async function markGreen(item, opts) {
    // A Bootstrap modal left open (e.g. by a failed item) would block the next one.
    for (const m of openDialogs().filter((d) => d.matches('.modal'))) {
      closeDialog(m);
      await waitFor(() => !visible(m), 3000);
    }
    const already = openDialogs(); // banners etc. that are not this item's dialog
    item.row.scrollIntoView({ block: 'center' });
    item.trigger.click();
    const dialog = await waitFor(() => openDialog(already), 6000);
    if (!dialog) return { ok: false, msg: 'the edit dialog did not open' };
    await sleep(350); // fade-in
    await waitFor(() => dialog.querySelector('input[type=radio], select'), 3000); // dialogs filled in after opening

    // Wrong dialog (another item's title)? Then stop rather than change the wrong item.
    const titleEl = ['.modal-title', '.swal2-title', '.ui-dialog-title', 'h1, h2, h3, h4, h5'].map((s) => dialog.querySelector(s)).find(Boolean);
    const title = norm(titleEl && titleEl.innerText);
    if (title && opts.labels && opts.labels.has(title) && title !== norm(item.label)) {
      closeDialog(dialog);
      return { ok: false, msg: 'the dialog that opened is for "' + clean(titleEl.innerText) + '", not "' + item.label + '"' };
    }

    const pick = chooseGreen(dialog);
    if (!pick.ok) {
      closeDialog(dialog);
      return pick;
    }
    fillDetails(dialog, opts.details);

    if (opts.dryRun) {
      await sleep(700);
      closeDialog(dialog);
      await waitFor(() => !visible(dialog), 3000);
      return { ok: true, msg: 'would pick "' + pick.picked + '" (dry run, cancelled)' };
    }

    const submit = submitButton(dialog);
    if (!submit) {
      closeDialog(dialog);
      return { ok: false, msg: 'no Submit button in the dialog' };
    }
    if (opts.beforeSubmit && (await opts.beforeSubmit()) === false) {
      closeDialog(dialog);
      return { ok: false, stopped: true, msg: 'stopped' };
    }
    submit.click();

    const closed = await waitFor(() => !visible(dialog) || !dialog.isConnected, 20000, 150);
    if (!closed) {
      const err = dialogErrors(dialog);
      closeDialog(dialog);
      return { ok: false, msg: 'the dialog stayed open after Submit' + (err ? ': ' + err : '') };
    }
    return { ok: true, msg: 'picked "' + pick.picked + '"' };
  }

  const api = { HOST_ID, visible, waitFor, sleep, norm, colorName, scan, locate, openDialog, chooseGreen, markGreen, rowState };
  root.AuditPage = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
