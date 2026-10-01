/*
 * Audit Autofill – content script for portal.bobcares.com.
 *
 * Shows a panel on the audit edit page. You give it a screenshot of the
 * previous audit; it reads which items were green (✓), lists them against the
 * items on this page for you to check, and then marks those items Active one
 * by one (open dialog → Active → Submit). Everything else is left as it is.
 *
 * The run is stored in browser.storage, so it carries on when Submit reloads
 * the page.
 */
(() => {
  'use strict';
  if (window.__auditAutofillLoaded) return;
  window.__auditAutofillLoaded = true;

  const api = typeof browser !== 'undefined' ? browser : chrome;
  const A = globalThis.AuditAnalyzer;
  const P = globalThis.AuditPage;

  const DEFAULT_SETTINGS = { keywords: 'Active, Enabled', delayMs: 800, skipDone: true, details: '' };
  const STALE_JOB_MS = 2 * 60 * 60 * 1000;
  const STATUS_TEXT = { green: '✓', red: '✗', na: 'NA', yellow: 'not done', unknown: '?', missing: '—' };
  const STATUS_COLOR = { green: '#16a34a', red: '#dc2626', na: '#9ca3af', grey: '#9ca3af', yellow: '#f59e0b', unknown: '#7c3aed', missing: '#d1d5db' };
  const RESULT_TEXT = { done: 'marked', skipped: 'skipped', failed: 'failed', check: 'check', 'dry-run': 'dry run' };

  let settings = { ...DEFAULT_SETTINGS };
  let page = { sections: [], items: 0 };
  let analysis = null;
  let refCanvas = null;
  let refName = '';
  let plan = null;
  let running = false;
  let highlighted = [];

  // ------------------------------------------------------------- storage

  async function load() {
    const st = await api.storage.local.get({ settings: DEFAULT_SETTINGS, job: null, lastRun: null });
    settings = { ...DEFAULT_SETTINGS, ...st.settings };
    return st;
  }
  const getJob = async () => (await api.storage.local.get({ job: null })).job;
  const saveJob = (job) => {
    job.updatedAt = Date.now();
    return api.storage.local.set({ job });
  };

  // The run belongs to the tab that started it (sessionStorage is per tab and
  // survives reloads), so other portal tabs don't join in or get redirected.
  const TAB_KEY = 'bobcaresAuditAutofillJob';
  const tabJob = () => {
    try {
      return sessionStorage.getItem(TAB_KEY);
    } catch {
      return null;
    }
  };
  const claimJob = (job) => {
    try {
      sessionStorage.setItem(TAB_KEY, String(job.id));
    } catch {
      // no sessionStorage: the run still works in this tab
    }
  };
  const keywords = () =>
    settings.keywords
      .split(/[,\n]/)
      .map((k) => k.trim())
      .filter(Boolean);

  // ------------------------------------------------------------- reference screenshot

  async function loadImage(blob, name) {
    if (!blob || !/^image\//.test(blob.type || '')) {
      ui.refMessage('That is not an image. Use a PNG / JPG / WebP screenshot.', 'error');
      return;
    }
    ui.refMessage('Reading ' + (name || 'image') + '…', 'info');
    try {
      const bmp = await createImageBitmap(blob);
      const scale = Math.min(1, Math.sqrt(24e6 / (bmp.width * bmp.height)));
      const c = document.createElement('canvas');
      c.width = Math.round(bmp.width * scale);
      c.height = Math.round(bmp.height * scale);
      const ctx = c.getContext('2d');
      ctx.drawImage(bmp, 0, 0, c.width, c.height);
      analysis = A.analyze(ctx.getImageData(0, 0, c.width, c.height));
      refCanvas = c;
      refName = name || 'screenshot';
    } catch (e) {
      ui.refMessage('Could not read the image: ' + e.message, 'error');
      return;
    }
    rescan();
  }

  function summary(a) {
    const rows = a.sections.flatMap((s) => s.rows);
    const n = (st) => rows.filter((r) => r.status === st).length;
    const kind = { view: 'View Audit page', edit: 'audit edit page', mixed: 'mixed', none: '' }[a.mode];
    return (
      a.sections.length + ' section(s), ' + rows.length + ' rows: ' + n('green') + ' ✓, ' + n('red') + ' ✗, ' + n('na') + ' NA' +
      (n('yellow') ? ', ' + n('yellow') + ' not done' : '') + (n('unknown') ? ', ' + n('unknown') + ' unreadable' : '') +
      (kind ? ' (' + kind + ')' : '')
    );
  }

  // ------------------------------------------------------------- page

  function scanPage() {
    page = P.scan();
    return page;
  }

  function rescan() {
    scanPage();
    plan = analysis ? A.matchToPage(analysis, page.sections, { skipDone: settings.skipDone }) : null;
    ui.render();
  }

  function clearHighlight() {
    for (const [el, outline, offset] of highlighted) {
      el.style.outline = outline;
      el.style.outlineOffset = offset;
    }
    highlighted = [];
  }

  function highlight() {
    clearHighlight();
    if (!plan) return 0;
    let n = 0;
    plan.sections.forEach((ps, si) =>
      ps.items.forEach((it, ii) => {
        const row = page.sections[si] && page.sections[si].items[ii] && page.sections[si].items[ii].row;
        if (!row || !it.mark) return;
        highlighted.push([row, row.style.outline, row.style.outlineOffset]);
        row.style.outline = '3px solid #16a34a';
        row.style.outlineOffset = '-3px';
        n++;
      })
    );
    return n;
  }

  // ------------------------------------------------------------- run

  function plannedItems() {
    const items = [];
    plan.sections.forEach((ps, s) =>
      ps.items.forEach((it, i) => {
        if (it.mark) items.push({ s, i, label: it.label, section: ps.name });
      })
    );
    return items;
  }

  async function start(dryRun) {
    if (running) return;
    const items = plannedItems();
    if (!items.length) {
      ui.status('Nothing is ticked.', 'warn');
      return;
    }
    clearHighlight();
    const job = {
      id: Date.now(),
      path: location.pathname,
      url: location.href.split('#')[0],
      items,
      pos: 0,
      phase: 'idle',
      submitAt: 0,
      bounces: 0,
      dryRun: !!dryRun,
      results: [],
    };
    claimJob(job);
    await saveJob(job);
    runJob();
  }

  // The stop request has its own key: the running loop saves the job after
  // every step and would otherwise overwrite it.
  const stopRequested = async (job) => (await api.storage.local.get({ stopJob: null })).stopJob === job.id;

  async function stop() {
    const job = await getJob();
    if (!job) return;
    if (running || job.phase === 'submitting') {
      await api.storage.local.set({ stopJob: job.id });
      ui.status('Stopping after the current item…', 'warn');
    } else {
      await finishJob(job, 'stopped');
    }
  }

  function record(job, it, result, msg) {
    job.results.push({ section: it.section, label: it.label, result, msg: msg || '' });
  }

  async function finishJob(job, how) {
    const lastRun = { path: job.path, finishedAt: Date.now(), how, dryRun: job.dryRun, results: job.results, total: job.items.length };
    await api.storage.local.set({ job: null, stopJob: null, lastRun });
    ui.showRun(lastRun);
  }

  async function runJob() {
    if (running) return;
    running = true;
    ui.setRunning(true);
    try {
      const labels = () => new Set(page.sections.flatMap((s) => s.items.map((it) => P.norm(it.label))));
      for (;;) {
        const job = await getJob();
        if (!job) break;
        if (await stopRequested(job)) {
          await finishJob(job, 'stopped');
          break;
        }
        if (job.pos >= job.items.length) {
          await finishJob(job, 'finished');
          break;
        }
        const it = job.items[job.pos];
        ui.showJob(job, (job.dryRun ? 'Dry run: ' : '') + it.section + ' → ' + it.label + '…');
        scanPage();
        const item = P.locate(page, it);
        let result;
        let msg;
        if (!item) {
          result = 'failed';
          msg = 'not found on this page';
        } else if (settings.skipDone && item.state === 'green' && !job.dryRun) {
          result = 'skipped';
          msg = 'already active';
        } else {
          const res = await P.markGreen(item, {
            keywords: keywords(),
            details: settings.details,
            dryRun: job.dryRun,
            labels: labels(),
            beforeSubmit: async () => {
              if (await stopRequested(job)) return false;
              job.phase = 'submitting';
              job.submitAt = Date.now();
              job.bounces = 0;
              await saveJob(job);
            },
          });
          if (res.stopped) {
            await finishJob(job, 'stopped');
            break;
          } else if (!res.ok) {
            result = 'failed';
            msg = res.msg;
          } else if (job.dryRun) {
            result = 'dry-run';
            msg = res.msg;
          } else {
            await P.sleep(500);
            const again = P.locate(scanPage(), it);
            const state = again ? again.state : 'unknown';
            result = state === 'green' || state === 'unknown' ? 'done' : 'check';
            msg = result === 'done' ? res.msg : res.msg + ', but the item does not show green on the page yet';
          }
        }
        const cur = await getJob();
        if (!cur || cur.id !== job.id) break;
        record(job, it, result, msg);
        job.phase = 'idle';
        job.pos++;
        await saveJob(job);
        ui.showJob(job);
        if (job.pos < job.items.length && !(await stopRequested(job))) await P.sleep(settings.delayMs);
      }
    } finally {
      running = false;
      ui.setRunning(false);
    }
  }

  // After a page load: carry on with a run that Submit interrupted.
  // Returns false when the run is none of this page's business.
  async function resume(job) {
    const idle = Date.now() - (job.updatedAt || job.id);
    if (idle > STALE_JOB_MS) {
      await api.storage.local.set({ job: null, stopJob: null });
      return false;
    }
    if (tabJob() !== String(job.id)) {
      // Started in another tab. Take it over only if that tab has gone quiet
      // and this tab is the same audit (e.g. the tab was closed and reopened).
      if (location.pathname !== job.path || idle < 30000) return false;
      claimJob(job);
    }
    if (job.phase === 'submitting') {
      const it = job.items[job.pos];
      let state = 'unknown';
      if (location.pathname === job.path) {
        const hit = P.locate(scanPage(), it);
        if (hit) state = hit.state;
      }
      const ok = state === 'green' || state === 'unknown';
      record(job, it, ok ? 'done' : 'check', ok ? 'saved' : 'saved, but the item does not show green on the page yet');
      job.phase = 'idle';
      job.pos++;
      await saveJob(job);
    }
    if (await stopRequested(job)) {
      await finishJob(job, 'stopped');
      return true;
    }
    if (location.pathname === job.path) {
      ui.open();
      ui.showJob(job);
      await P.sleep(settings.delayMs);
      runJob();
      return true;
    }
    // Submit landed on another page (e.g. a "saved" page): go back to the audit.
    if (Date.now() - job.submitAt < 60000 && job.bounces < 2) {
      job.bounces++;
      await saveJob(job);
      location.assign(job.url);
      return true;
    }
    ui.open();
    ui.showPaused(job);
    return true;
  }

  // ------------------------------------------------------------- UI (shadow DOM)

  const ui = (() => {
    let host;
    let root;
    const $ = (sel) => root.querySelector(sel);
    const el = (tag, cls, text) => {
      const e = document.createElement(tag);
      if (cls) e.className = cls;
      if (text !== undefined) e.textContent = text;
      return e;
    };

    function mount() {
      if (host) return;
      host = document.createElement('div');
      host.id = P.HOST_ID;
      root = host.attachShadow({ mode: 'open' });
      root.innerHTML = `
        <style>
          :host { all: initial; }
          * { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
          .launcher { position: fixed; right: 16px; bottom: 16px; z-index: 2147483646; border: 0; border-radius: 999px;
                      background: #16a34a; color: #fff; font-size: 13px; font-weight: 600; padding: 9px 14px; cursor: pointer;
                      box-shadow: 0 6px 18px rgba(0,0,0,.25); }
          .panel { position: fixed; right: 16px; bottom: 16px; z-index: 2147483646; width: 400px; max-width: calc(100vw - 32px);
                   max-height: calc(100vh - 32px); display: flex; flex-direction: column;
                   background: #fff; color: #1f2937; border: 1px solid #d1d5db; border-radius: 10px;
                   box-shadow: 0 8px 28px rgba(0,0,0,.18); font-size: 13px; line-height: 1.4; }
          .head { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-bottom: 1px solid #e5e7eb; }
          .head b { flex: 1; font-size: 13px; }
          .badge { font-size: 11px; padding: 2px 8px; border-radius: 999px; background: #e5e7eb; color: #374151; }
          .badge.run { background: #dcfce7; color: #166534; }
          .body { padding: 8px 10px; overflow: auto; flex: 1; }
          h3 { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: #6b7280; margin: 10px 0 6px; }
          h3:first-child { margin-top: 2px; }
          .drop { border: 2px dashed #cbd5e1; border-radius: 8px; padding: 12px; text-align: center; color: #475569; cursor: pointer; }
          .drop.over { border-color: #2563eb; background: #eff6ff; }
          .drop:focus-visible { outline: 2px solid #2563eb; outline-offset: 2px; }
          .drop small { display: block; color: #6b7280; margin-top: 4px; }
          canvas.preview { display: block; width: 100%; margin-top: 8px; border: 1px solid #e5e7eb; border-radius: 6px; cursor: zoom-in; }
          .msg { margin: 6px 0 0; }
          .msg.error { color: #b91c1c; } .msg.warn { color: #92400e; } .msg.ok { color: #166534; }
          ul.warn { margin: 6px 0 0; padding-left: 18px; color: #92400e; font-size: 12px; }
          .sec { border: 1px solid #e5e7eb; border-radius: 8px; margin: 6px 0; }
          .sec.bad { border-color: #f59e0b; }
          .sec-h { display: flex; align-items: center; gap: 6px; padding: 5px 8px; background: #f8fafc; border-bottom: 1px solid #e5e7eb;
                   border-radius: 8px 8px 0 0; font-weight: 600; }
          .sec-h span { flex: 1; }
          .sec-h small { font-weight: 400; color: #6b7280; }
          .item { display: flex; align-items: center; gap: 6px; padding: 3px 8px; }
          .item label { flex: 1; display: flex; align-items: center; gap: 6px; cursor: pointer; }
          .item .note { font-size: 11px; color: #6b7280; }
          .chip { font-size: 11px; padding: 0 6px; border-radius: 999px; color: #fff; white-space: nowrap; min-width: 22px; text-align: center; }
          .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; flex: none; }
          .legend { font-size: 11px; color: #6b7280; margin: 2px 0 4px; }
          .actions { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding: 8px 10px; border-top: 1px solid #e5e7eb; }
          button { font: inherit; font-size: 12px; padding: 5px 10px; border-radius: 6px; border: 1px solid #d1d5db;
                   background: #f9fafb; color: #111827; cursor: pointer; }
          button.primary { background: #16a34a; border-color: #16a34a; color: #fff; }
          button.danger { background: #dc2626; border-color: #dc2626; color: #fff; }
          button:disabled { opacity: .5; cursor: default; }
          button:focus-visible { outline: 2px solid #2563eb; outline-offset: 2px; }
          button.link { border: 0; background: none; color: #2563eb; padding: 0 2px; }
          .x { border: 0; background: none; font-size: 16px; padding: 0 4px; color: #6b7280; }
          .check { display: flex; align-items: center; gap: 6px; font-size: 12px; }
          .status { margin: 0 0 4px; font-weight: 600; }
          .status.warn { color: #92400e; } .status.error { color: #b91c1c; } .status.ok { color: #166534; }
          .bar { height: 6px; background: #e5e7eb; border-radius: 999px; overflow: hidden; margin: 4px 0 8px; }
          .bar i { display: block; height: 100%; background: #16a34a; width: 0; }
          table { border-collapse: collapse; width: 100%; font-size: 12px; }
          td { padding: 3px 4px; border-bottom: 1px solid #f3f4f6; vertical-align: top; overflow-wrap: anywhere; }
          td.r { white-space: nowrap; font-weight: 600; }
          td.r.done, td.r.dry-run { color: #166534; } td.r.failed { color: #b91c1c; } td.r.check { color: #92400e; } td.r.skipped { color: #6b7280; }
          td small { color: #6b7280; }
          details { margin-top: 10px; }
          summary { cursor: pointer; color: #374151; font-weight: 600; }
          .field { display: block; margin: 6px 0; font-size: 12px; }
          .field input[type=text], .field input[type=number], .field textarea { display: block; width: 100%; margin-top: 2px; font: inherit;
                   padding: 4px 6px; border: 1px solid #d1d5db; border-radius: 6px; }
          .muted { color: #6b7280; font-size: 12px; }
          .hidden { display: none !important; }
          .zoom { position: fixed; inset: 0; z-index: 2147483647; background: rgba(15,23,42,.7); display: flex;
                  align-items: center; justify-content: center; padding: 16px; cursor: zoom-out; }
          .zoom canvas { max-width: 100%; max-height: 100%; background: #fff; border-radius: 6px; }
        </style>
        <button class="launcher hidden" id="launcher" title="Audit Autofill">✓ Audit Autofill</button>
        <div class="panel hidden" role="region" aria-label="Audit Autofill">
          <div class="head">
            <b>Audit Autofill</b><span class="badge" id="badge">Idle</span>
            <button class="x" id="close" title="Hide" aria-label="Hide">×</button>
          </div>
          <div class="body">
            <div id="setup">
              <h3>1. Previous audit screenshot</h3>
              <div class="drop" id="drop" tabindex="0" role="button">
                <b>Drop, paste (Ctrl+V) or click to choose</b>
                <small>Screenshot of the previous month's <i>View Server Audit</i> page with all six sections visible (zoom out to 50% if needed).</small>
              </div>
              <input type="file" id="file" accept="image/*" class="hidden" />
              <canvas class="preview hidden" id="preview" title="Click to enlarge"></canvas>
              <p class="msg" id="refMsg"></p>
              <ul class="warn" id="warnings"></ul>
              <h3>2. Items to mark Active on this page</h3>
              <div class="legend" id="legend"></div>
              <div id="plan"><p class="muted">Add the screenshot first.</p></div>
            </div>
            <div id="runBox" class="hidden">
              <p class="status" id="status"></p>
              <div class="bar"><i id="barFill"></i></div>
              <table><tbody id="results"></tbody></table>
            </div>
            <details id="settingsBox">
              <summary>Settings</summary>
              <label class="field">Names of the green option in the item dialog (comma separated)
                <input type="text" id="setKeywords" /></label>
              <label class="field">Wait between items (ms)
                <input type="number" id="setDelay" min="200" max="10000" step="100" /></label>
              <label class="check"><input type="checkbox" id="setSkip" /> Skip items that are already green on this page</label>
              <label class="field">Text for "Additional details" when it is empty (leave blank to not touch it)
                <textarea id="setDetails" rows="2"></textarea></label>
            </details>
          </div>
          <div class="actions">
            <button class="primary" id="apply" disabled>Mark items Active</button>
            <button id="dry" disabled title="Opens each item, picks Active, then presses Cancel">Dry run</button>
            <button id="hl" disabled>Highlight</button>
            <button id="rescan" title="Read this page's items again">Rescan page</button>
            <button class="danger hidden" id="stop">Stop</button>
            <button class="hidden" id="back">Back</button>
          </div>
        </div>`;
      document.documentElement.appendChild(host);

      $('#launcher').addEventListener('click', open);
      $('#close').addEventListener('click', () => {
        $('.panel').classList.add('hidden');
        $('#launcher').classList.remove('hidden');
        clearHighlight();
      });
      const drop = $('#drop');
      drop.addEventListener('click', () => $('#file').click());
      drop.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          $('#file').click();
        }
      });
      $('#file').addEventListener('change', (e) => {
        const f = e.target.files && e.target.files[0];
        if (f) loadImage(f, f.name);
        e.target.value = '';
      });
      const panel = $('.panel');
      panel.addEventListener('dragover', (e) => {
        e.preventDefault();
        drop.classList.add('over');
      });
      panel.addEventListener('dragleave', (e) => {
        if (!panel.contains(e.relatedTarget)) drop.classList.remove('over');
      });
      panel.addEventListener('drop', (e) => {
        e.preventDefault();
        drop.classList.remove('over');
        const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (f) loadImage(f, f.name);
      });
      $('#preview').addEventListener('click', zoom);
      $('#apply').addEventListener('click', () => start(false));
      $('#dry').addEventListener('click', () => start(true));
      $('#hl').addEventListener('click', () => {
        if (highlighted.length) {
          clearHighlight();
          $('#hl').textContent = 'Highlight';
        } else {
          const n = highlight();
          $('#hl').textContent = 'Clear highlight';
          status(n + ' row(s) outlined in green on the page.', 'ok');
        }
      });
      $('#rescan').addEventListener('click', rescan);
      $('#stop').addEventListener('click', stop);
      $('#back').addEventListener('click', () => {
        view('setup');
        rescan();
      });

      $('#setKeywords').value = settings.keywords;
      $('#setDelay').value = settings.delayMs;
      $('#setSkip').checked = settings.skipDone;
      $('#setDetails').value = settings.details;
      const saveSettings = async () => {
        settings = {
          keywords: $('#setKeywords').value.trim() || DEFAULT_SETTINGS.keywords,
          delayMs: Math.min(10000, Math.max(200, parseInt($('#setDelay').value, 10) || DEFAULT_SETTINGS.delayMs)),
          skipDone: $('#setSkip').checked,
          details: $('#setDetails').value,
        };
        await api.storage.local.set({ settings });
      };
      ['#setKeywords', '#setDelay', '#setDetails'].forEach((s) => $(s).addEventListener('change', saveSettings));
      $('#setSkip').addEventListener('change', async () => {
        await saveSettings();
        rescan();
      });

      // Paste a screenshot straight from the clipboard while the panel is open.
      document.addEventListener(
        'paste',
        (e) => {
          if ($('.panel').classList.contains('hidden') || running) return;
          const items = [...((e.clipboardData && e.clipboardData.items) || [])];
          const img = items.find((i) => i.kind === 'file' && /^image\//.test(i.type));
          if (!img) return;
          e.preventDefault();
          e.stopPropagation();
          loadImage(img.getAsFile(), 'pasted screenshot');
        },
        true
      );

      const legend = $('#legend');
      legend.append('Screenshot: ');
      ['green', 'red', 'na', 'yellow'].forEach((s) => {
        const c = el('span', 'chip', STATUS_TEXT[s]);
        c.style.background = STATUS_COLOR[s];
        legend.append(c, ' ');
      });
      legend.append(' · dot = colour on this page now');
    }

    function open() {
      mount();
      $('#launcher').classList.add('hidden');
      $('.panel').classList.remove('hidden');
      render();
    }

    function showLauncher() {
      mount();
      if ($('.panel').classList.contains('hidden')) $('#launcher').classList.remove('hidden');
    }

    function refMessage(text, level) {
      mount();
      $('#refMsg').textContent = text;
      $('#refMsg').className = 'msg ' + (level || '');
    }

    function status(text, level) {
      mount();
      $('#status').textContent = text;
      $('#status').className = 'status ' + (level || '');
      if (!running && $('#runBox').classList.contains('hidden')) refMessage(text, level);
    }

    function drawOverlay(canvas, width) {
      const scale = width / refCanvas.width;
      canvas.width = Math.round(refCanvas.width * scale);
      canvas.height = Math.round(refCanvas.height * scale);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(refCanvas, 0, 0, canvas.width, canvas.height);
      const line = Math.max(1.5, width / 500);
      analysis.sections.forEach((s, i) => {
        const last = s.rows[s.rows.length - 1];
        const x0 = s.box.x0 * scale;
        const y0 = s.box.y0 * scale;
        const w = (s.box.x1 - s.box.x0) * scale;
        const barH = (s.box.y1 - s.box.y0 + 1) * scale;
        const h = ((last ? last.y1 : s.box.y1) - s.box.y0) * scale + barH * 0.5;
        ctx.lineWidth = line;
        ctx.strokeStyle = '#f59e0b';
        ctx.strokeRect(x0, y0, w, h);
        // Section number at the right end of the header bar (the name stays readable).
        const size = Math.max(10, barH * 0.75);
        ctx.fillStyle = '#f59e0b';
        ctx.fillRect(x0 + w - size * 1.2, y0, size * 1.2, barH);
        ctx.fillStyle = '#fff';
        ctx.font = 'bold ' + Math.round(size) + 'px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(i + 1), x0 + w - size * 0.6, y0 + barH / 2);
        // A ring around each icon that was read, in the colour it was read as.
        ctx.lineWidth = line * 1.6;
        s.rows.forEach((row) => {
          const ic = row.icon;
          const cx = ((ic.x0 + ic.x1) / 2) * scale;
          const cy = ((ic.y0 + ic.y1) / 2) * scale;
          const rad = Math.max(4, Math.max(ic.x1 - ic.x0, ic.y1 - ic.y0) * scale * 0.5 + line * 2.5);
          ctx.beginPath();
          ctx.arc(cx, cy, rad, 0, Math.PI * 2);
          ctx.strokeStyle = STATUS_COLOR[row.status];
          ctx.stroke();
        });
      });
    }

    function zoom() {
      if (!refCanvas) return;
      const z = el('div', 'zoom');
      const c = document.createElement('canvas');
      drawOverlay(c, Math.min(refCanvas.width, 2400));
      z.append(c);
      z.addEventListener('click', () => z.remove());
      root.append(z);
    }

    function render() {
      mount();
      const planBox = $('#plan');
      const warnBox = $('#warnings');
      warnBox.textContent = '';
      if (analysis && refCanvas) {
        $('#preview').classList.remove('hidden');
        drawOverlay($('#preview'), 760);
        refMessage(refName + ': ' + summary(analysis), analysis.sections.length ? 'ok' : 'error');
      }
      if (!page.sections.length) {
        planBox.textContent = '';
        planBox.append(el('p', 'msg warn', 'No audit items found on this page. Open the audit edit page (the one with the green edit buttons) and press "Rescan page".'));
      } else if (!plan) {
        planBox.textContent = '';
        planBox.append(
          el('p', 'muted', 'This page: ' + page.sections.length + ' section(s), ' + page.items + ' items (' + page.sections.map((s) => s.name + ' ' + s.items.length).join(', ') + '). Add the screenshot to continue.')
        );
      } else {
        [...(analysis.warnings || []), ...plan.warnings].forEach((w) => warnBox.append(el('li', '', w)));
        planBox.textContent = '';
        plan.sections.forEach((ps, si) => planBox.append(sectionBox(ps, si)));
      }
      updateButtons();
    }

    function sectionBox(ps, si) {
      const box = el('div', 'sec' + (ps.mismatch || !ps.refRows ? ' bad' : ''));
      const h = el('div', 'sec-h');
      const name = el('span', '', si + 1 + '. ' + ps.name + ' ');
      name.append(el('small', '', '(page ' + ps.items.length + ', screenshot ' + ps.refRows + ')'));
      const all = el('button', 'link', 'all');
      const none = el('button', 'link', 'none');
      const setAll = (v) => {
        ps.items.forEach((it) => (it.mark = v));
        render();
      };
      all.addEventListener('click', () => setAll(true));
      none.addEventListener('click', () => setAll(false));
      h.append(name, all, none);
      box.append(h);
      ps.items.forEach((it) => {
        const row = el('div', 'item');
        const label = el('label');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = it.mark;
        cb.addEventListener('change', () => {
          it.mark = cb.checked;
          updateButtons();
        });
        const dot = el('span', 'dot');
        dot.style.background = STATUS_COLOR[it.state] || STATUS_COLOR.unknown;
        dot.title = 'On this page now: ' + it.state;
        label.append(cb, dot, el('span', '', it.label));
        if (it.note) label.append(el('span', 'note', '(' + it.note + ')'));
        const chip = el('span', 'chip', STATUS_TEXT[it.ref] || '?');
        chip.style.background = STATUS_COLOR[it.ref] || STATUS_COLOR.unknown;
        chip.title = 'In the screenshot: ' + it.ref;
        row.append(label, chip);
        box.append(row);
      });
      return box;
    }

    function updateButtons() {
      const n = plan ? plan.sections.reduce((a, s) => a + s.items.filter((i) => i.mark).length, 0) : 0;
      $('#apply').textContent = 'Mark ' + n + ' item' + (n === 1 ? '' : 's') + ' Active';
      ['#apply', '#dry', '#hl'].forEach((s) => ($(s).disabled = running || !n));
      $('#rescan').disabled = running;
    }

    // Setup view (screenshot + list) or run view (progress + results).
    function view(name) {
      const run = name === 'run';
      $('#setup').classList.toggle('hidden', run);
      $('#runBox').classList.toggle('hidden', !run);
      ['#apply', '#dry', '#hl', '#rescan'].forEach((s) => $(s).classList.toggle('hidden', run));
      $('#back').classList.toggle('hidden', !run || running);
      $('#stop').classList.toggle('hidden', !run || !running);
    }

    function setRunning(on) {
      mount();
      $('#badge').textContent = on ? 'Running' : 'Idle';
      $('#badge').className = 'badge' + (on ? ' run' : '');
      if (on) view('run');
      else $('#stop').classList.add('hidden');
      updateButtons();
    }

    function results(list, total) {
      const tb = $('#results');
      tb.textContent = '';
      list.forEach((r) => {
        const tr = el('tr');
        tr.append(el('td', 'r ' + r.result, RESULT_TEXT[r.result] || r.result));
        const td = el('td', '', r.label + ' ');
        td.append(el('small', '', '(' + r.section + ')'));
        if (r.msg) {
          td.append(el('br'));
          td.append(el('small', '', r.msg));
        }
        tr.append(td);
        tb.append(tr);
      });
      $('#barFill').style.width = total ? Math.round((list.length / total) * 100) + '%' : '0';
    }

    function showJob(job, text) {
      open();
      view('run');
      status(text || (job.dryRun ? 'Dry run' : 'Marking items Active') + ': ' + job.pos + ' / ' + job.items.length, 'info');
      results(job.results, job.items.length);
    }

    function showPaused(job) {
      showJob(job, 'A run for another audit is paused (' + job.pos + ' / ' + job.items.length + '). Open that audit to continue, or press Stop.');
      $('#status').className = 'status warn';
      $('#back').classList.add('hidden');
      $('#stop').classList.remove('hidden');
    }

    function showRun(run) {
      open();
      view('run');
      $('#back').classList.remove('hidden');
      $('#stop').classList.add('hidden');
      const n = (r) => run.results.filter((x) => x.result === r).length;
      const parts = [];
      if (run.dryRun) parts.push(n('dry-run') + ' checked (dry run, nothing saved)');
      else parts.push(n('done') + ' marked Active');
      if (n('skipped')) parts.push(n('skipped') + ' already active');
      if (n('check')) parts.push(n('check') + ' to check');
      if (n('failed')) parts.push(n('failed') + ' failed');
      status((run.how === 'stopped' ? 'Stopped. ' : 'Done. ') + parts.join(', ') + '.', n('failed') || n('check') ? 'warn' : 'ok');
      results(run.results, run.total);
    }

    return { open, showLauncher, refMessage, status, render, setRunning, showJob, showPaused, showRun };
  })();

  // ------------------------------------------------------------- wiring

  api.runtime.onMessage.addListener((msg) => {
    if (!msg || !msg.type) return undefined;
    if (msg.type === 'ping') {
      if (!running) scanPage();
      return getJob().then((job) => ({ ok: true, sections: page.sections.length, items: page.items, running, job: !!job }));
    }
    if (msg.type === 'open-panel') {
      ui.open();
      return Promise.resolve({ ok: true });
    }
    return undefined;
  });

  (async () => {
    const st = await load();
    if (st.job && (await resume(st.job))) return;
    // The audit list can be drawn after the page loads: look a few times.
    for (const wait of [0, 1000, 2500, 5000]) {
      await P.sleep(wait);
      scanPage();
      if (page.items >= 2) break;
    }
    if (page.items < 2) return;
    ui.showLauncher();
    const run = st.lastRun;
    if (run && run.path === location.pathname && Date.now() - run.finishedAt < 10 * 60 * 1000) {
      ui.showRun(run);
      await api.storage.local.set({ lastRun: null });
    }
  })();
})();
