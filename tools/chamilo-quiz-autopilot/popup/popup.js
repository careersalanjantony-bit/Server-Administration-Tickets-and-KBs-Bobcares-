(() => {
  'use strict';

  const api = typeof browser !== 'undefined' ? browser : chrome;
  const M = globalThis.QuizMatcher;
  const B = globalThis.QuizBank;
  const DEFAULTS = { running: false, delayMs: 1500, draft: '', learn: false };
  const $ = (id) => document.getElementById(id);

  function msg(text, level, canUndo) {
    $('msgText').textContent = text || '';
    $('msg').className = 'msg ' + (level || '');
    $('undo').hidden = !canUndo;
  }

  function renderPreview() {
    const entries = B.parseAny($('key').value);
    $('parsed').textContent = $('key').value.trim()
      ? entries.length
        ? entries.length + ' question(s) recognised in the box'
        : 'No questions recognised in the box yet'
      : '';
    const ol = $('preview');
    ol.textContent = '';
    for (const e of entries) {
      const li = document.createElement('li');
      const a = document.createElement('span');
      a.className = 'a';
      a.textContent = e.a.split('\n').join(' • ');
      li.append(e.q + ' → ', a);
      ol.append(li);
    }
    return entries;
  }

  async function renderBankCount() {
    $('bankCount').textContent = (await B.load(api)).length;
  }

  const ago = (t) => {
    const s = Math.round((Date.now() - t) / 1000);
    return s < 60 ? 'just now' : s < 3600 ? Math.round(s / 60) + ' min ago' : new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  let isTemporary = false;
  async function renderCloud() {
    let info = null;
    try {
      info = await api.runtime.sendMessage({ type: 'syncInfo' });
    } catch (e) {
      /* background not reachable */
    }
    const el = $('cloud');
    const on = !!(info && info.url && info.hasKey);
    const st = info && info.status;
    $('syncBtn').hidden = !on;
    if (!on) {
      el.textContent = 'Cloud sync: off (set it up in the bank)';
      el.className = 'cloud';
    } else if (st && st.state === 'error') {
      el.textContent = 'Cloud sync problem: ' + st.message;
      el.className = 'cloud error';
    } else {
      el.textContent =
        'Cloud sync on' + (st && st.state === 'ok' ? ', synced ' + ago(st.at) : '') + (info.pending ? ' · ' + info.pending + ' change(s) to upload' : '');
      el.className = 'cloud ok';
    }
    // Temporary installs lose their storage (and connection settings) on restart.
    const warn = $('tempWarn');
    warn.hidden = !isTemporary || (on && info.builtIn);
    warn.textContent = on
      ? 'Loaded temporarily: your questions are safe in the cloud, but Firefox forgets the connection when it restarts. Put the address and key in config.js to connect automatically.'
      : 'Loaded temporarily: Firefox deletes the saved questions when it restarts. Turn on cloud sync (Open bank → Cloud sync) or export a backup.';
  }

  async function syncNow() {
    $('cloud').textContent = 'Syncing with the cloud…';
    try {
      await api.runtime.sendMessage({ type: 'sync' });
    } catch (e) {
      /* shown by renderCloud */
    }
    await renderBankCount();
    await renderCloud();
  }

  function renderState(running) {
    $('state').textContent = running ? 'Running' : 'Idle';
    $('state').className = 'badge' + (running ? ' run' : '');
    $('start').hidden = running;
    $('stop').hidden = !running;
  }

  async function saveSettings() {
    const delay = Math.min(10000, Math.max(300, parseInt($('delay').value, 10) || DEFAULTS.delayMs));
    $('delay').value = delay;
    await api.storage.local.set({ delayMs: delay, learn: $('learn').checked });
  }

  // Merge whatever is in the box into the bank (a no-op when nothing is new).
  async function saveBox(quiet) {
    if (!$('key').value.trim()) return null;
    const r = await B.addFromText(api, $('key').value, 'pasted');
    await renderBankCount();
    if (!r.recognised) {
      if (!quiet) {
        msg('No questions recognised in the box. Put each question on its own line with its answer below it (e.g. "Answer: ...").', 'warn');
      }
    } else if (!quiet || r.added || r.updated) {
      msg('Question bank: ' + B.summary(r) + '.', '', !!(r.added || r.updated));
    }
    return r;
  }

  async function activeTabHasQuiz() {
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    if (!tab) return null;
    try {
      const res = await api.tabs.sendMessage(tab.id, { type: 'ping' });
      return { tab, questions: res ? res.questions : 0 };
    } catch (e) {
      return { tab, questions: -1 }; // content script not injected: not a Chamilo exercise page
    }
  }

  async function init() {
    const st = await api.storage.local.get(DEFAULTS);
    $('key').value = st.draft;
    $('delay').value = st.delayMs;
    $('learn').checked = st.learn;
    renderPreview();
    renderState(st.running);
    await renderBankCount();

    try {
      isTemporary = (await api.management.getSelf()).installType === 'development';
    } catch (e) {
      /* management API not available - skip the warning */
    }
    await renderCloud();
    syncNow(); // get the latest questions from the cloud

    // Keep what's typed even if the popup closes.
    let t;
    $('key').addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(() => {
        renderPreview();
        api.storage.local.set({ draft: $('key').value });
      }, 250);
    });
    // A paste is saved straight away.
    $('key').addEventListener('paste', () => {
      setTimeout(async () => {
        renderPreview();
        await api.storage.local.set({ draft: $('key').value });
        await saveBox(true);
      }, 0);
    });

    $('save').addEventListener('click', () => saveBox(false));
    $('syncBtn').addEventListener('click', syncNow);
    $('clearBox').addEventListener('click', async () => {
      $('key').value = '';
      renderPreview();
      await api.storage.local.set({ draft: '' });
      msg('');
    });
    $('undo').addEventListener('click', async () => {
      if (await B.undo(api)) msg('Last change undone.');
      await renderBankCount();
    });
    $('openBank').addEventListener('click', () => {
      api.runtime.openOptionsPage();
      window.close();
    });
    $('delay').addEventListener('change', saveSettings);
    $('learn').addEventListener('change', saveSettings);

    $('start').addEventListener('click', async () => {
      await saveSettings();
      await saveBox(true);
      if (!(await B.load(api)).length) return msg('Your question bank is empty. Paste your questions and answers first.', 'warn');
      const info = await activeTabHasQuiz();
      if (!info || info.questions < 0) {
        return msg('Open the quiz (…/main/exercise/exercise_submit.php) in this tab first, then press Start.', 'warn');
      }
      await api.storage.local.set({ running: true, log: [], guard: null });
      renderState(true);
      msg(info.questions ? 'Running on this tab.' : 'Running. It will start answering when a question page loads.');
    });

    $('stop').addEventListener('click', async () => {
      await api.storage.local.set({ running: false });
      renderState(false);
      msg('Stopped.');
    });

    $('once').addEventListener('click', async () => {
      await saveSettings();
      await saveBox(true);
      if (!(await B.load(api)).length) return msg('Your question bank is empty. Paste your questions and answers first.', 'warn');
      const info = await activeTabHasQuiz();
      if (!info || info.questions <= 0) return msg('No quiz question found in this tab.', 'warn');
      await api.tabs.sendMessage(info.tab.id, { type: 'answer-once' });
      msg('Answer filled in on the page. Check the panel at the bottom-right.');
    });

    api.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes.running) renderState(!!changes.running.newValue);
      if (changes.bank) renderBankCount();
      if (changes.syncStatus || changes.pendingOps) renderCloud();
    });
  }

  init();
})();
