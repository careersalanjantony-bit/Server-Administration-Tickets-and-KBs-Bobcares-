(() => {
  'use strict';

  const api = typeof browser !== 'undefined' ? browser : chrome;
  const M = globalThis.QuizMatcher;
  const DEFAULTS = { answerKey: '', running: false, delayMs: 1500 };
  const $ = (id) => document.getElementById(id);

  function msg(text, level) {
    $('msg').textContent = text || '';
    $('msg').className = 'msg ' + (level || '');
  }

  function renderPreview() {
    const entries = M.parseKey($('key').value);
    $('parsed').textContent = entries.length ? entries.length + ' question(s) recognised' : 'No questions recognised yet';
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

  function renderState(running) {
    $('state').textContent = running ? 'Running' : 'Idle';
    $('state').className = 'badge' + (running ? ' run' : '');
    $('start').hidden = running;
    $('stop').hidden = !running;
  }

  async function saveKey() {
    const entries = renderPreview();
    const delay = Math.min(10000, Math.max(300, parseInt($('delay').value, 10) || DEFAULTS.delayMs));
    $('delay').value = delay;
    await api.storage.local.set({ answerKey: $('key').value, delayMs: delay });
    return entries;
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
    $('key').value = st.answerKey;
    $('delay').value = st.delayMs;
    renderPreview();
    renderState(st.running);

    let t;
    $('key').addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(renderPreview, 250);
    });

    $('save').addEventListener('click', async () => {
      const entries = await saveKey();
      msg(entries.length ? 'Saved.' : 'Saved, but no question/answer pairs were recognised.', entries.length ? '' : 'warn');
    });

    $('start').addEventListener('click', async () => {
      const entries = await saveKey();
      if (!entries.length) return msg('Paste your answer key first.', 'warn');
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
      const entries = await saveKey();
      if (!entries.length) return msg('Paste your answer key first.', 'warn');
      const info = await activeTabHasQuiz();
      if (!info || info.questions <= 0) return msg('No quiz question found in this tab.', 'warn');
      await api.tabs.sendMessage(info.tab.id, { type: 'answer-once' });
      msg('Answer ticked on the page. Check the panel at the bottom-right.');
    });

    api.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.running) renderState(!!changes.running.newValue);
    });
  }

  init();
})();
