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

  const DEFAULTS = { answerKey: '', running: false, delayMs: 1500, log: [], guard: null };
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

  function answerInputs() {
    const all = [...document.querySelectorAll('input[type=radio], input[type=checkbox]')];
    // Chamilo answer inputs are named choice[<questionId>] / choice[<qid>][<aid>].
    const usable = all.filter((i) => !i.disabled);
    const choice = usable.filter((i) => /^choice/.test(i.name || ''));
    return choice.length ? choice : usable.filter((i) => !/remind|review|marked/i.test(i.name || '') && visible(i));
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

  function findQuestions() {
    const inputs = answerInputs();
    if (!inputs.length) return [];
    const titles = [...document.querySelectorAll('.question_title')].filter(visible);
    const groups = new Map();

    for (const input of inputs) {
      let title = null;
      for (const t of titles) {
        if (t.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING) title = t;
      }
      if (!title) title = precedingHeading(input);
      if (!title) continue;
      if (!groups.has(title)) groups.set(title, []);
      groups.get(title).push(input);
    }

    const questions = [];
    for (const [titleEl, ins] of groups) {
      const container = titleEl.closest('.main-question, [id^="question_div_"]');
      const desc = container && container.querySelector('.question_description');
      questions.push({
        titleEl,
        inputs: ins,
        labels: ins.map(optionLabelEl),
        text: questionTitleText(titleEl),
        extraText: desc ? textOf(desc) : '',
        options: ins.map((i) => textOf(optionLabelEl(i))),
        multi: ins.some((i) => i.type === 'checkbox'),
      });
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

  function setChecked(input, on) {
    if (input.checked === on) return;
    input.click();
    if (input.checked !== on) {
      input.checked = on;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  function clearHighlights() {
    for (const { el, style } of highlighted) el.setAttribute('style', style);
    highlighted = [];
  }

  function highlight(el, color) {
    highlighted.push({ el, style: el.getAttribute('style') || '' });
    el.style.outline = '3px solid ' + color;
    el.style.outlineOffset = '3px';
    el.style.borderRadius = '4px';
  }

  function applyResult(q, r) {
    if (!r.picks.length) return;
    if (q.multi) {
      q.inputs.forEach((input, i) => setChecked(input, r.picks.includes(i)));
    } else {
      setChecked(q.inputs[r.picks[0]], true);
    }
    for (const i of r.picks) highlight(q.labels[i], COLORS[r.confidence]);
  }

  function selectedText(q) {
    return q.inputs
      .map((input, i) => (input.checked ? q.options[i] : null))
      .filter(Boolean)
      .join(' + ');
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

    const entries = M.parseKey(st.answerKey);
    if (!entries.length) {
      ui.status('Your answer key is empty. Open the Quiz Autopilot toolbar popup and paste it first.', 'error');
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
    lastResults = questions.map((q) => {
      const r = M.solve(q, entries);
      applyResult(q, r);
      return r;
    });
    await recordAnswers(questions, lastResults, false);
    ui.showResults(questions, lastResults);

    if (!auto) {
      ui.status(mode === 'once' ? 'Answer ticked. Nothing else was clicked.' : '', 'info');
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

  // "Continue" after a pause – use whatever is ticked now (yours or ours).
  async function continueManually() {
    const questions = findQuestions();
    const missing = questions.filter((q) => !q.inputs.some((i) => i.checked));
    if (missing.length) {
      ui.status('Tick an answer first, then press Continue.', 'warn');
      return;
    }
    await recordAnswers(questions, lastResults, lastResults.some((r) => r.confidence !== 'high'));
    ui.setPaused(false);
    const st = await load();
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
          table { border-collapse: collapse; width: 100%; }
          td, th { text-align: left; vertical-align: top; padding: 6px 4px; border-bottom: 1px solid #f3f4f6; }
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
        aEl.textContent = r.picks.length ? '→ ' + r.picks.map((p) => q.options[p]).join(' + ') : '→ (nothing ticked)';
        div.append(qEl, aEl);
        if (r.entry) {
          const k = document.createElement('div');
          k.className = 'q';
          k.textContent =
            'Key: "' + r.entry.q + '" → "' + r.entry.a + '" (question ' + Math.round(r.qScore * 100) + '%, answer ' + Math.round(r.aScore * 100) + '%)';
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
