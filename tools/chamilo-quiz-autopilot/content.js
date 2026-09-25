/*
 * Quiz Autopilot – content script for Chamilo exercise pages.
 *
 * On every quiz page load: find the question(s), match them against the
 * answer key, tick the answer, and (while the autopilot is running) press
 * "Next question". It never presses "End test" by itself – it shows a
 * confirmation dialog with a summary and waits for you.
 */
(() => {
  'use strict';
  if (window.__quizAutopilotLoaded) return;
  window.__quizAutopilotLoaded = true;

  const api = typeof browser !== 'undefined' ? browser : chrome;
  const M = globalThis.QuizMatcher;
  const B = globalThis.QuizBank;

  const DEFAULTS = { running: false, delayMs: 1500, log: [], guard: null, learn: false };
  const COLORS = { high: '#16a34a', low: '#d97706', none: '#dc2626' };

  let timer = null;
  let busy = false;
  let lastResults = [];
  let highlighted = [];

  // ------------------------------------------------------------- storage

  const load = () => api.storage.local.get(DEFAULTS);
  const save = (obj) => api.storage.local.set(obj);

  // ------------------------------------------------------------- page reading

  const visible = (el) => !!(el && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
  const textOf = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');

  // Chamilo names every answer control choice[<questionId>]...: radios and
  // checkboxes (single/multiple answer), selects (matching / ordering) and
  // text fields (fill in the blanks / open question). On customised pages we
  // fall back to any visible radio or checkbox.
  function answerControls() {
    const usable = (sel) => [...document.querySelectorAll(sel)].filter((el) => !el.disabled);
    const choice = (el) => /^choice/.test(el.name || '');
    const boxes = usable('input[type=radio], input[type=checkbox]');
    const named = boxes.filter(choice);
    const picked = named.length ? named : boxes.filter((i) => !/remind|review|marked/i.test(i.name || '') && visible(i));
    const others = usable('select, input[type=text], textarea').filter(choice);
    return picked.concat(others).sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  }

  function optionLabelEl(input) {
    let label = input.closest('label');
    if (!label && input.id) label = document.querySelector('label[for="' + CSS.escape(input.id) + '"]');
    if (label && textOf(label)) return label;
    for (const el of [input.parentElement, input.closest('td, li, tr, .radio, .checkbox')]) {
      if (el && textOf(el)) return el;
    }
    return input.parentElement || input;
  }

  function questionTitleText(titleEl) {
    const clone = titleEl.cloneNode(true);
    // Optional "#COURSE-123" id heading that Chamilo can prepend.
    clone.querySelectorAll('h4').forEach((h) => {
      if (/^#/.test(textOf(h))) h.remove();
    });
    return textOf(clone);
  }

  // Heading-like element right before the first answer (fallback when the page
  // has no .question_title, e.g. a customised Chamilo theme).
  function precedingHeading(input) {
    const candidates = [...document.querySelectorAll('.question_title, h1, h2, h3, h4, h5, legend, strong, .panel-heading')].filter(
      (el) => el.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING && !el.contains(input) && textOf(el).length > 8
    );
    return candidates[candidates.length - 1] || null;
  }

  // ---- drop-down (matching / ordering) questions

  const PLACEHOLDER = /^(-+|\.+|select\b.*|choose\b.*)?$/i;

  // Chamilo matching questions list the right-hand side as "A. text" and the
  // drop-downs only show the letters; map the letters back to their text.
  function letterMap(container) {
    const map = {};
    if (!container) return map;
    for (const el of container.querySelectorAll('td, li, p, div, span, label')) {
      if (el.querySelector('select, input')) continue;
      const t = textOf(el);
      const m = t.length < 400 && t.match(/^([A-Z])\s*[.)]\s+(.+)$/);
      if (m && !map[m[1]]) map[m[1]] = m[2];
    }
    return map;
  }

  // Text that labels one drop-down: the other cell(s) in its table row, its
  // <label>, or the text around it.
  function rowLabel(sel) {
    const tr = sel.closest('tr');
    if (tr) {
      for (const cell of tr.children) if (!cell.contains(sel) && textOf(cell)) return textOf(cell);
    }
    if (sel.id) {
      const l = document.querySelector('label[for="' + CSS.escape(sel.id) + '"]');
      if (l && textOf(l)) return textOf(l);
    }
    for (let el = sel.parentElement; el && el !== document.body; el = el.parentElement) {
      if (el.querySelectorAll('select').length > 1) break;
      const clone = el.cloneNode(true);
      clone.querySelectorAll('select').forEach((x) => x.remove());
      if (textOf(clone)) return textOf(clone);
    }
    return '';
  }

  function selectRow(sel, letters) {
    const opts = [...sel.options].filter((o) => o.value !== '' && !PLACEHOLDER.test(textOf(o)));
    return {
      label: rowLabel(sel),
      options: opts.map((o) => letters[textOf(o)] || textOf(o)),
      optionEls: opts,
    };
  }

  // ---- drag-and-drop ordering questions (Chamilo "sequence ordering")

  function itemText(li) {
    const opt = li.querySelector('.exercise-draggable-answer-option');
    if (opt) return textOf(opt);
    const clone = li.cloneNode(true);
    clone.querySelectorAll('select, .hidden, [hidden]').forEach((x) => x.remove());
    return textOf(clone);
  }

  // The draggable items and the numbered slots they get dropped on, or null.
  // Chamilo's class names first; jQuery UI's own ui-draggable / ui-droppable
  // markers as a fallback for other themes and versions.
  function dragParts(container) {
    if (!container) return null;
    let items = [...new Set(container.querySelectorAll('li.touch-items, .exercise-draggable-answer > li, .ui-draggable'))];
    items = items.filter((it) => !it.classList.contains('ui-draggable-dragging') && !items.some((o) => o !== it && o.contains(it)));
    const drops = [...new Set(container.querySelectorAll('.droppable, [id^="drop_"], .ui-droppable'))];
    const gallery =
      container.querySelector('.exercise-draggable-answer') ||
      drops.find((z) => z.matches('ul, ol') && items.filter((it) => z.contains(it)).length >= 2) ||
      null;
    const zones = drops.filter((z) => z !== gallery && !(gallery && z.contains(gallery)) && !items.some((it) => it === z || it.contains(z)));
    if (!items.length || !zones.length) return null;
    const slots = zones
      .map((z, i) => {
        const m = (z.id || '').match(/_(\d+)$/);
        const num = z.parentElement && z.parentElement.querySelector('.number');
        const pos = m ? +m[1] : parseInt(num ? textOf(num) : '', 10) || i + 1;
        return { el: z, pos };
      })
      .sort((a, b) => a.pos - b.pos);
    return { gallery, items: items.map((el) => ({ el, text: itemText(el) })), slots };
  }

  function findQuestions() {
    const controls = answerControls();
    const titles = [...document.querySelectorAll('.question_title')].filter(visible);
    const groups = new Map();
    // Drag-and-drop questions may have no named controls at all.
    for (const t of titles) {
      if (dragParts(t.closest('.main-question, [id^="question_div_"]'))) groups.set(t, []);
    }
    if (!controls.length && !groups.size) return [];

    for (const ctrl of controls) {
      let title = null;
      for (const t of titles) {
        if (t.compareDocumentPosition(ctrl) & Node.DOCUMENT_POSITION_FOLLOWING) title = t;
      }
      if (!title) title = precedingHeading(ctrl);
      if (!title) continue;
      if (!groups.has(title)) groups.set(title, []);
      groups.get(title).push(ctrl);
    }

    const questions = [];
    for (const [titleEl, ctrls] of groups) {
      let container = titleEl.closest('.main-question, [id^="question_div_"]');
      if (!container && ctrls.length) {
        container = titleEl.parentElement;
        while (container && container !== document.body && !container.contains(ctrls[0])) container = container.parentElement;
      }
      const desc = container && container.querySelector('.question_description');
      const base = { titleEl, text: questionTitleText(titleEl), extraText: desc ? textOf(desc) : '' };

      const boxes = ctrls.filter((el) => el.tagName === 'INPUT' && (el.type === 'radio' || el.type === 'checkbox'));
      const selects = ctrls.filter((el) => el.tagName === 'SELECT');
      const fields = ctrls.filter((el) => el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && el.type === 'text'));

      const drag = dragParts(container);
      if (drag) {
        // Solved like a matching question: each item -> a slot number.
        const positions = drag.slots.map((sl) => String(sl.pos));
        questions.push(Object.assign(base, { kind: 'drag', drag, rows: drag.items.map((it) => ({ label: it.text, options: positions })) }));
      } else if (selects.length) {
        const letters = letterMap(container);
        questions.push(Object.assign(base, { kind: 'select', selects, rows: selects.map((s) => selectRow(s, letters)) }));
      } else if (boxes.length) {
        questions.push(
          Object.assign(base, {
            kind: 'choice',
            inputs: boxes,
            labels: boxes.map(optionLabelEl),
            options: boxes.map((i) => textOf(optionLabelEl(i))),
            multi: boxes.some((i) => i.type === 'checkbox'),
          })
        );
      } else if (fields.length) {
        questions.push(Object.assign(base, { kind: 'text', fields, fieldCount: fields.length }));
      }
    }
    return questions;
  }

  function findNavButtons() {
    const els = [...document.querySelectorAll('button, input[type=submit], input[type=button], a.btn')].filter(visible);
    let next = null;
    let end = null;
    for (const el of els) {
      const label = (el.tagName === 'INPUT' ? el.value : el.textContent).replace(/\s+/g, ' ').trim().toLowerCase();
      if (!label || /previous|\bprev\b|\bback\b/.test(label)) continue;
      if (!next && /\bnext\b/.test(label)) next = el;
      else if (!end && /\b(end|finish|submit|terminate|complete)\b|validate|review/.test(label)) end = el;
    }
    return { next, end };
  }

  // ------------------------------------------------------------- page actions

  const fire = (el) => {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };

  function setChecked(input, on) {
    if (input.checked === on) return;
    input.click();
    if (input.checked !== on) {
      input.checked = on;
      fire(input);
    }
  }

  function setText(field, text) {
    field.value = text;
    fire(field);
    // Open questions use CKEditor, which keeps its own copy of the text.
    try {
      const page = window.wrappedJSObject || window;
      const inst = page.CKEDITOR && page.CKEDITOR.instances && (page.CKEDITOR.instances[field.id] || page.CKEDITOR.instances[field.name]);
      if (inst) inst.setData(text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>'));
    } catch (e) {
      /* editor not reachable - the textarea itself still has the text */
    }
  }

  function clearHighlights() {
    for (const { el, style } of highlighted) el.setAttribute('style', style);
    highlighted = [];
  }

  function highlight(el, color) {
    if (!visible(el) && el.parentElement) el = el.parentElement;
    highlighted.push({ el, style: el.getAttribute('style') || '' });
    el.style.outline = '3px solid ' + color;
    el.style.outlineOffset = '3px';
    el.style.borderRadius = '4px';
  }

  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

  // Page coordinates of an element's centre.
  function pageCenter(el) {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2 + window.scrollX, y: r.top + r.height / 2 + window.scrollY };
  }

  function mouse(type, target, p) {
    const x = p.x - window.scrollX;
    const y = p.y - window.scrollY;
    target.dispatchEvent(
      new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: x,
        clientY: y,
        screenX: x,
        screenY: y,
        button: 0,
        buttons: type === 'mouseup' ? 0 : 1,
      })
    );
  }

  // Drag the way a person does: press on the item, move in small steps, release
  // over the target. Chamilo's own drop handler then records the answer.
  async function dragTo(itemEl, targetEl) {
    const handle = itemEl.querySelector('.exercise-draggable-answer-option') || itemEl;
    handle.scrollIntoView({ block: 'center' });
    await sleep(80);
    const a = pageCenter(handle);
    const b = pageCenter(targetEl);
    mouse('mousedown', handle, a);
    const steps = 10;
    for (let i = 1; i <= steps; i++) {
      mouse('mousemove', document, { x: a.x + ((b.x - a.x) * i) / steps, y: a.y + ((b.y - a.y) * i) / steps });
      await sleep(16);
    }
    mouse('mouseup', document, b);
    await sleep(750); // Chamilo fades the item out and back in
  }

  // Put an item back in the list (it sits in the wrong slot).
  async function recycle(itemEl, gallery) {
    if (gallery && gallery.getBoundingClientRect().height > 8) return dragTo(itemEl, gallery);
    try {
      const page = window.wrappedJSObject || window;
      if (page.DraggableAnswer && page.jQuery) {
        page.DraggableAnswer.recycleItem(page.jQuery(page.document.getElementById(itemEl.id)));
        await sleep(750);
      }
    } catch (e) {
      /* could not reach the page's helper - verification below will catch it */
    }
    return undefined;
  }

  // Returns true when every item ended up in the slot we wanted.
  async function applyDrag(q, r) {
    const { slots, gallery, items } = q.drag;
    const want = new Map();
    items.forEach((it, i) => {
      const p = r.rowPicks[i];
      if (p != null && p >= 0) want.set(it.el, slots[p].el);
    });
    if (!want.size) return false;
    for (const it of items) {
      const inSlot = slots.find((sl) => sl.el.contains(it.el));
      if (inSlot && want.get(it.el) !== inSlot.el) await recycle(it.el, gallery);
    }
    for (const [el, slotEl] of want) {
      if (!slotEl.contains(el)) await dragTo(el, slotEl);
    }
    await sleep(200);
    return [...want].every(([el, slotEl]) => slotEl.contains(el));
  }

  async function applyResult(q, r) {
    const color = COLORS[r.confidence];
    if (q.kind === 'drag') {
      if (!r.rowPicks.length) return;
      const ok = await applyDrag(q, r);
      if (!ok) {
        r.confidence = 'low';
        r.reason = (r.reason ? r.reason + ' ' : '') + 'Could not finish dragging automatically - drag the items into the order shown, then press Continue.';
      }
      for (const sl of q.drag.slots) highlight(sl.el.closest('.droppable-item') || sl.el, COLORS[r.confidence]);
      return;
    }
    if (q.kind === 'select') {
      q.rows.forEach((row, i) => {
        const pick = r.rowPicks[i];
        if (pick == null || pick < 0) return;
        const sel = q.selects[i];
        const opt = row.optionEls[pick];
        if (sel.value !== opt.value) {
          sel.value = opt.value;
          opt.selected = true;
          fire(sel);
        }
        highlight(sel, color);
      });
      return;
    }
    if (q.kind === 'text') {
      r.fills.forEach((text, i) => {
        if (!q.fields[i]) return;
        setText(q.fields[i], text);
        highlight(q.fields[i], color);
      });
      return;
    }
    if (!r.picks.length) return;
    if (q.multi) {
      q.inputs.forEach((input, i) => setChecked(input, r.picks.includes(i)));
    } else {
      setChecked(q.inputs[r.picks[0]], true);
    }
    for (const i of r.picks) highlight(q.labels[i], color);
  }

  const selectedOption = (sel) => {
    const o = sel.options[sel.selectedIndex];
    return o && o.value !== '' && !PLACEHOLDER.test(textOf(o)) ? o : null;
  };

  const itemInSlot = (q, slotEl) => q.drag.items.find((it) => slotEl.contains(it.el));

  function isAnswered(q) {
    if (q.kind === 'drag') return q.drag.slots.every((sl) => itemInSlot(q, sl.el));
    if (q.kind === 'select') return q.selects.every(selectedOption);
    if (q.kind === 'text') return q.fields.some((f) => f.value.trim());
    return q.inputs.some((i) => i.checked);
  }

  // What is on the page right now (ours or the user's own choice).
  function selectedText(q) {
    if (q.kind === 'drag') {
      return q.drag.slots.map((sl) => sl.pos + '. ' + ((itemInSlot(q, sl.el) || {}).text || '?')).join('; ');
    }
    if (q.kind === 'select') {
      return q.rows
        .map((row, i) => {
          const o = selectedOption(q.selects[i]);
          const at = o ? row.optionEls.indexOf(o) : -1;
          return row.label + ' → ' + (o ? (at >= 0 ? row.options[at] : textOf(o)) : '?');
        })
        .join('; ');
    }
    if (q.kind === 'text') return q.fields.map((f) => f.value.trim()).filter(Boolean).join(' | ');
    return q.inputs
      .map((input, i) => (input.checked ? q.options[i] : null))
      .filter(Boolean)
      .join(' + ');
  }

  // What the autopilot chose, for the panel.
  function plannedText(q, r) {
    if (q.kind === 'drag') {
      if (!r.rowPicks.length) return '(nothing placed)';
      return q.drag.slots
        .map((sl, j) => {
          const i = r.rowPicks.indexOf(j);
          return sl.pos + '. ' + (i >= 0 ? q.drag.items[i].text : '?');
        })
        .join('; ');
    }
    if (q.kind === 'select') {
      return r.rowPicks.length ? q.rows.map((row, i) => row.label + ' → ' + (r.rowPicks[i] >= 0 ? row.options[r.rowPicks[i]] : '?')).join('; ') : '(nothing selected)';
    }
    if (q.kind === 'text') return r.fills.length ? r.fills.join(' | ') : '(nothing typed)';
    return r.picks.length ? r.picks.map((p) => q.options[p]).join(' + ') : '(nothing ticked)';
  }

  async function recordAnswers(questions, results, manual) {
    const { log } = await load();
    questions.forEach((q, i) => {
      const r = results[i] || {};
      const item = {
        question: q.text,
        answer: selectedText(q),
        confidence: manual ? 'manual' : r.confidence,
      };
      const at = log.findIndex((l) => M.norm(l.question) === M.norm(q.text));
      if (at >= 0) log[at] = item;
      else log.push(item);
    });
    await save({ log });
  }

  // ------------------------------------------------------------- main flow

  function schedule(fn, ms) {
    clearTimeout(timer);
    timer = setTimeout(fn, ms);
  }

  async function run(mode) {
    if (busy) return;
    busy = true;
    try {
      await step(mode);
    } catch (err) {
      ui.status('Error: ' + (err && err.message ? err.message : err), 'error');
      console.error('[Quiz Autopilot]', err);
    } finally {
      busy = false;
    }
  }

  async function step(mode) {
    const st = await load();
    const auto = mode === 'auto' && st.running;
    const questions = findQuestions();
    const nav = findNavButtons();

    if (!questions.length) {
      // e.g. Chamilo's "review your answers" page – only an End button left.
      if (auto && nav.end && !nav.next) return confirmEnd(nav.end);
      if (mode !== 'passive') ui.status('No quiz question found on this page.', 'warn');
      return;
    }

    const entries = await B.load(api);
    if (!entries.length) {
      ui.status('Your question bank is empty. Open the Quiz Autopilot toolbar popup and paste your questions and answers first.', 'error');
      if (st.running) await save({ running: false });
      return;
    }

    // Loop guard: stop if "Next" doesn't move us off this question.
    const sig = questions.map((q) => M.norm(q.text)).join('\n');
    if (auto) {
      const guard = st.guard && st.guard.sig === sig ? { sig, count: st.guard.count + 1 } : { sig, count: 1 };
      await save({ guard });
      if (guard.count > 3) {
        await save({ running: false });
        ui.status('Stopped: this question came back several times, so "Next" is not advancing. Check the page.', 'error');
        return;
      }
    }

    clearHighlights();
    lastResults = [];
    for (const q of questions) {
      const r = M.solve(q, entries);
      await applyResult(q, r);
      lastResults.push(r);
    }
    await recordAnswers(questions, lastResults, false);
    ui.showResults(questions, lastResults);

    if (!auto) {
      ui.status(mode === 'once' ? 'Answer filled in. Nothing else was clicked.' : '', 'info');
      return;
    }

    const unsure = lastResults.some((r) => r.confidence !== 'high');
    if (unsure) {
      ui.status('Paused: not sure about this question. Check the highlighted answer (or pick one yourself), then press Continue.', 'warn');
      ui.setPaused(true);
      return;
    }
    advance(nav, st.delayMs);
  }

  function advance(nav, delayMs) {
    if (nav.next) {
      ui.status('Clicking "Next question" in ' + (delayMs / 1000).toFixed(1) + 's…', 'info');
      schedule(() => nav.next.click(), delayMs);
    } else if (nav.end) {
      schedule(() => confirmEnd(nav.end), Math.min(delayMs, 600));
    } else {
      ui.status('No "Next question" or "End test" button found on this page.', 'warn');
      ui.setPaused(true);
    }
  }

  // The answer on the page, written the way the question bank stores answers.
  function bankAnswer(q) {
    if (q.kind === 'drag') return q.drag.slots.map((sl) => sl.pos + '. ' + ((itemInSlot(q, sl.el) || {}).text || '')).join('\n');
    if (q.kind === 'select') return selectedText(q).split('; ').join('\n');
    if (q.kind === 'text') return q.fields.map((f) => f.value.trim()).filter(Boolean).join('\n');
    return q.inputs
      .map((input, i) => (input.checked ? q.options[i] : null))
      .filter(Boolean)
      .join('\n');
  }

  // "Also save answers I pick myself": questions the autopilot was not sure
  // about are saved (or updated) with the answer now on the page.
  async function learn(questions) {
    const incoming = [];
    questions.forEach((q, i) => {
      if (lastResults[i] && lastResults[i].confidence === 'high') return;
      const a = bankAnswer(q);
      if (a) incoming.push({ q: q.text, a });
    });
    if (!incoming.length) return;
    const r = B.merge(await B.load(api), incoming, 'learned');
    if (r.added || r.updated) await B.save(api, r.bank);
  }

  // "Continue" after a pause – use whatever is ticked now (yours or ours).
  async function continueManually() {
    const questions = findQuestions();
    const missing = questions.filter((q) => !isAnswered(q));
    if (missing.length) {
      ui.status('Answer the question first (tick, select or type), then press Continue.', 'warn');
      return;
    }
    await recordAnswers(questions, lastResults, lastResults.some((r) => r.confidence !== 'high'));
    ui.setPaused(false);
    const st = await load();
    if (st.learn) await learn(questions);
    if (!st.running) await save({ running: true, guard: null });
    advance(findNavButtons(), 300);
  }

  async function confirmEnd(endBtn) {
    const { log } = await load();
    ui.status('Last question reached. Waiting for your confirmation before ending the test.', 'warn');
    const ok = await ui.confirmEnd(log, textOf(endBtn) || endBtn.value || 'End test');
    if (ok) {
      await save({ running: false, guard: null });
      ui.status('Ending the test…', 'info');
      endBtn.click();
    } else {
      await save({ running: false, guard: null });
      ui.status('Not ended. Autopilot stopped. Review your answers and press "End test" yourself when ready.', 'info');
    }
  }

  // ------------------------------------------------------------- UI (shadow DOM)

  const ui = (() => {
    let host;
    let root;
    const $ = (sel) => root.querySelector(sel);

    function mount() {
      if (host) return;
      host = document.createElement('div');
      host.id = 'quiz-autopilot-host';
      root = host.attachShadow({ mode: 'open' });
      root.innerHTML = `
        <style>
          :host { all: initial; }
          * { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
          .panel { position: fixed; right: 16px; bottom: 16px; z-index: 2147483646; width: 360px; max-width: calc(100vw - 32px);
                   background: #fff; color: #1f2937; border: 1px solid #d1d5db; border-radius: 10px;
                   box-shadow: 0 8px 28px rgba(0,0,0,.18); font-size: 13px; line-height: 1.4; }
          .head { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-bottom: 1px solid #e5e7eb; }
          .head b { flex: 1; font-size: 13px; }
          .badge { font-size: 11px; padding: 2px 8px; border-radius: 999px; background: #e5e7eb; color: #374151; }
          .badge.run { background: #dcfce7; color: #166534; }
          .badge.pause { background: #fef3c7; color: #92400e; }
          .body { padding: 8px 10px; max-height: 40vh; overflow: auto; }
          .status { margin: 0 0 6px; }
          .status.warn { color: #92400e; } .status.error { color: #b91c1c; } .status.info { color: #1f2937; }
          .res { border-left: 3px solid #d1d5db; padding: 2px 0 2px 8px; margin: 6px 0; }
          .res .q { color: #6b7280; font-size: 12px; }
          .res .a { font-weight: 600; }
          .res .why { color: #92400e; font-size: 12px; }
          .actions { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px 10px; border-top: 1px solid #e5e7eb; }
          button { font: inherit; font-size: 12px; padding: 5px 10px; border-radius: 6px; border: 1px solid #d1d5db;
                   background: #f9fafb; color: #111827; cursor: pointer; }
          button.primary { background: #2563eb; border-color: #2563eb; color: #fff; }
          button.danger { background: #dc2626; border-color: #dc2626; color: #fff; }
          button:focus-visible { outline: 2px solid #2563eb; outline-offset: 2px; }
          .x { border: 0; background: none; font-size: 16px; padding: 0 4px; color: #6b7280; }
          .hidden { display: none !important; }
          .overlay { position: fixed; inset: 0; z-index: 2147483647; background: rgba(15,23,42,.55);
                     display: flex; align-items: center; justify-content: center; padding: 16px; }
          .modal { background: #fff; color: #111827; border-radius: 12px; width: 720px; max-width: 100%; max-height: 90vh;
                   display: flex; flex-direction: column; box-shadow: 0 20px 50px rgba(0,0,0,.35); font-size: 13px; }
          .modal h2 { margin: 0; padding: 14px 16px 4px; font-size: 17px; }
          .modal p { margin: 0; padding: 0 16px 10px; color: #4b5563; }
          .modal .list { overflow: auto; padding: 0 16px; border-top: 1px solid #e5e7eb; border-bottom: 1px solid #e5e7eb; }
          table { border-collapse: collapse; width: 100%; table-layout: fixed; }
          td, th { text-align: left; vertical-align: top; padding: 6px 4px; border-bottom: 1px solid #f3f4f6; overflow-wrap: anywhere; }
          th:nth-child(1) { width: 47%; } th:nth-child(2) { width: 40%; } th:nth-child(3) { width: 13%; }
          .res .q, .res .a { overflow-wrap: anywhere; }
          th { position: sticky; top: 0; background: #fff; font-size: 12px; color: #6b7280; }
          .flag { font-size: 11px; padding: 1px 6px; border-radius: 999px; white-space: nowrap; }
          .flag.high { background: #dcfce7; color: #166534; } .flag.low { background: #fef3c7; color: #92400e; }
          .flag.manual { background: #dbeafe; color: #1e40af; } .flag.none { background: #fee2e2; color: #991b1b; }
          .modal .actions { justify-content: flex-end; border-top: 0; padding: 12px 16px; }
          .modal button { font-size: 14px; padding: 8px 14px; }
        </style>
        <div class="panel" role="region" aria-label="Quiz Autopilot">
          <div class="head">
            <b>Quiz Autopilot</b><span class="badge" id="badge">Idle</span>
            <button class="x" id="close" title="Hide for this page" aria-label="Hide">×</button>
          </div>
          <div class="body"><p class="status info" id="status"></p><div id="results"></div></div>
          <div class="actions">
            <button class="primary" id="start">Start autopilot</button>
            <button id="stop" class="hidden">Stop</button>
            <button id="continue" class="primary hidden">Continue</button>
            <button id="once">Answer this page only</button>
          </div>
        </div>`;
      document.documentElement.appendChild(host);

      $('#close').addEventListener('click', () => $('.panel').classList.add('hidden'));
      $('#start').addEventListener('click', async () => {
        await save({ running: true, log: [], guard: null });
      });
      $('#stop').addEventListener('click', () => save({ running: false }));
      $('#continue').addEventListener('click', () => continueManually());
      $('#once').addEventListener('click', () => run('once'));
    }

    function show() {
      mount();
      $('.panel').classList.remove('hidden');
    }

    function status(msg, level) {
      show();
      const el = $('#status');
      el.textContent = msg || '';
      el.className = 'status ' + (level || 'info');
    }

    function setRunning(running) {
      mount();
      $('#badge').textContent = running ? 'Running' : 'Idle';
      $('#badge').className = 'badge' + (running ? ' run' : '');
      $('#start').classList.toggle('hidden', running);
      $('#stop').classList.toggle('hidden', !running);
      if (!running) {
        clearTimeout(timer);
        $('#continue').classList.add('hidden');
      }
    }

    function setPaused(paused) {
      mount();
      $('#continue').classList.toggle('hidden', !paused);
      if (paused) {
        $('#badge').textContent = 'Paused';
        $('#badge').className = 'badge pause';
      }
    }

    function showResults(questions, results) {
      show();
      const box = $('#results');
      box.textContent = '';
      questions.forEach((q, i) => {
        const r = results[i];
        const div = document.createElement('div');
        div.className = 'res';
        div.style.borderLeftColor = COLORS[r.confidence];
        const qEl = document.createElement('div');
        qEl.className = 'q';
        qEl.textContent = q.text;
        const aEl = document.createElement('div');
        aEl.className = 'a';
        aEl.textContent = '→ ' + plannedText(q, r);
        div.append(qEl, aEl);
        if (r.entry) {
          const k = document.createElement('div');
          k.className = 'q';
          k.textContent =
            'Key: "' + r.entry.q + '" → "' + r.entry.a.split('\n').join(' • ') + '" (question ' + Math.round(r.qScore * 100) + '%' + (q.kind === 'text' ? '' : ', answer ' + Math.round(r.aScore * 100) + '%') + ')';
          div.append(k);
        }
        if (r.reason) {
          const w = document.createElement('div');
          w.className = 'why';
          w.textContent = r.reason;
          div.append(w);
        }
        box.append(div);
      });
    }

    function confirmEnd(log, endLabel) {
      show();
      return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'overlay';
        overlay.innerHTML = `
          <div class="modal" role="dialog" aria-modal="true" aria-labelledby="qa-title">
            <h2 id="qa-title">Ready to end the test?</h2>
            <p></p>
            <div class="list"><table><thead><tr><th>Question</th><th>Your answer</th><th></th></tr></thead><tbody></tbody></table></div>
            <div class="actions">
              <button id="no">Not yet, let me review</button>
              <button id="yes" class="danger"></button>
            </div>
          </div>`;
        const unsure = log.filter((l) => l.confidence !== 'high').length;
        overlay.querySelector('p').textContent =
          log.length + ' question(s) answered this run' + (unsure ? ', ' + unsure + ' of them marked for checking.' : '.') +
          ' Nothing is submitted until you press the red button.';
        overlay.querySelector('#yes').textContent = 'Yes, ' + endLabel;
        const tbody = overlay.querySelector('tbody');
        log.forEach((l) => {
          const tr = document.createElement('tr');
          const flag = { high: 'sure', low: 'check', manual: 'you picked', none: 'no match' }[l.confidence] || l.confidence;
          [l.question, l.answer || '(none)'].forEach((t) => {
            const td = document.createElement('td');
            td.textContent = t;
            tr.append(td);
          });
          const td = document.createElement('td');
          const span = document.createElement('span');
          span.className = 'flag ' + l.confidence;
          span.textContent = flag;
          td.append(span);
          tr.append(td);
          tbody.append(tr);
        });
        const done = (v) => {
          overlay.remove();
          resolve(v);
        };
        overlay.querySelector('#yes').addEventListener('click', () => done(true));
        overlay.querySelector('#no').addEventListener('click', () => done(false));
        overlay.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') done(false);
        });
        root.append(overlay);
        overlay.querySelector('#no').focus();
      });
    }

    return { status, setRunning, setPaused, showResults, confirmEnd, show };
  })();

  // ------------------------------------------------------------- wiring

  api.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.running) return;
    const running = !!changes.running.newValue;
    ui.setRunning(running);
    if (running && !changes.running.oldValue) run('auto');
    if (!running) ui.status('Autopilot stopped.', 'info');
  });

  api.runtime.onMessage.addListener((msg) => {
    if (!msg || !msg.type) return undefined;
    if (msg.type === 'ping') return Promise.resolve({ ok: true, questions: findQuestions().length });
    if (msg.type === 'answer-once') {
      run('once');
      return Promise.resolve({ ok: true });
    }
    return undefined;
  });

  (async () => {
    const st = await load();
    const hasQuiz = findQuestions().length > 0;
    if (st.running || hasQuiz) {
      ui.setRunning(st.running);
      if (!st.running) ui.status('Press "Start autopilot" to answer and move through the quiz automatically.', 'info');
    }
    if (st.running) run('auto');
  })();
})();
