(() => {
  'use strict';

  const api = typeof browser !== 'undefined' ? browser : chrome;
  const B = globalThis.QuizBank;
  const $ = (id) => document.getElementById(id);
  const SOURCES = { pasted: 'pasted', manual: 'added by hand', learned: 'picked in a quiz', imported: 'imported' };

  let bank = [];
  let editing = null; // id of the entry being edited

  function msg(text, level) {
    $('msg').textContent = text || '';
    $('msg').className = 'msg ' + (level || '');
  }

  const fmtDate = (t) => (t ? new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');

  // Text with the search words highlighted (built with DOM nodes, never innerHTML).
  function highlighted(text, words) {
    const frag = document.createDocumentFragment();
    if (!words.length) {
      frag.append(text);
      return frag;
    }
    const re = new RegExp('(' + words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')', 'ig');
    let last = 0;
    text.replace(re, (m, _g, i) => {
      frag.append(text.slice(last, i));
      const mk = document.createElement('mark');
      mk.textContent = m;
      frag.append(mk);
      last = i + m.length;
      return m;
    });
    frag.append(text.slice(last));
    return frag;
  }

  function button(label, cls, onClick) {
    const b = document.createElement('button');
    b.textContent = label;
    b.className = 'small ' + (cls || '');
    b.addEventListener('click', onClick);
    return b;
  }

  function render() {
    $('count').textContent = bank.length;
    const words = $('search').value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const list = $('list');
    list.textContent = '';
    let shown = 0;
    bank.forEach((e, i) => {
      const hay = (e.q + '\n' + e.a).toLowerCase();
      if (words.length && !words.every((w) => hay.includes(w))) return;
      shown++;
      const li = document.createElement('li');
      li.className = 'item';

      if (editing === e.id) {
        const q = document.createElement('textarea');
        q.rows = 2;
        q.value = e.q;
        q.setAttribute('aria-label', 'Question');
        const a = document.createElement('textarea');
        a.rows = Math.min(10, Math.max(2, e.a.split('\n').length + 1));
        a.value = e.a;
        a.setAttribute('aria-label', 'Answer');
        const row = document.createElement('div');
        row.className = 'row';
        row.append(
          button('Save', 'primary', () => saveEdit(e.id, q.value, a.value)),
          button('Cancel', '', () => {
            editing = null;
            render();
          })
        );
        li.append(q, a, row);
        list.append(li);
        q.focus();
        return;
      }

      const q = document.createElement('p');
      q.className = 'q';
      const n = document.createElement('span');
      n.className = 'n';
      n.textContent = i + 1 + '.';
      q.append(n, highlighted(e.q, words));
      const ul = document.createElement('ul');
      ul.className = 'a';
      for (const line of e.a.split('\n')) {
        const item = document.createElement('li');
        item.append(highlighted(line, words));
        ul.append(item);
      }
      const meta = document.createElement('div');
      meta.className = 'meta';
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = SOURCES[e.source] || e.source || 'saved';
      const dates = document.createElement('span');
      dates.textContent =
        'Added ' + fmtDate(e.added) + (e.updated && e.updated !== e.added ? ' · answer updated ' + fmtDate(e.updated) : '');
      const sp = document.createElement('span');
      sp.className = 'spacer';
      meta.append(
        tag,
        dates,
        sp,
        button('Edit', '', () => {
          editing = e.id;
          render();
        })
      );
      li.append(q, ul, meta);
      list.append(li);
    });
    $('empty').hidden = bank.length > 0;
    if (bank.length && !shown) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'No saved question matches your search.';
      list.append(li);
    }
  }

  async function reload() {
    bank = await B.load(api);
    render();
  }

  async function saveEdit(id, q, a) {
    q = q.trim();
    a = a
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .join('\n');
    if (!q || !a) return msg('Both the question and the answer are needed.', 'warn');
    const k = B.keyOf(q);
    if (bank.some((e) => e.id !== id && B.keyOf(e.q) === k)) return msg('Another saved question already has this text.', 'warn');
    const next = bank.map((e) =>
      e.id === id ? Object.assign({}, e, { q, a, prev: e.a !== a ? e.a : e.prev, updated: Date.now(), source: e.source }) : e
    );
    editing = null;
    await B.save(api, next);
    msg('Saved.');
    await reload();
  }

  // ---- cloud sync panel

  let isTemporary = false;
  let cloudOn = false;

  const send = async (m) => {
    try {
      return await api.runtime.sendMessage(m);
    } catch (e) {
      return { state: 'error', message: 'The add-on background page is not running. Reload the add-on.' };
    }
  };

  async function renderSync() {
    const info = (await send({ type: 'syncInfo' })) || {};
    const st = info.status || {};
    cloudOn = !!(info.url && info.hasKey);
    const pill = $('syncState');
    pill.textContent = !cloudOn ? 'Off' : st.state === 'error' ? 'Problem' : 'Connected';
    pill.className = 'pill' + (cloudOn ? (st.state === 'error' ? ' error' : ' ok') : '');
    $('syncNow').hidden = !cloudOn;
    $('disconnectBtn').hidden = !cloudOn;
    $('connectBtn').textContent = cloudOn ? 'Save and reconnect' : 'Connect';
    if (cloudOn && document.activeElement !== $('syncUrl')) $('syncUrl').value = info.url;
    $('syncKey').placeholder = cloudOn ? 'Saved (type a new one to change it)' : 'The BANK_TOKEN you set in Vercel';
    const when = st.at ? new Date(st.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
    $('syncMsg').textContent = !cloudOn
      ? 'Keep this question bank on your own Vercel server, so every computer with the add-on uses the same questions and answers.'
      : st.state === 'error'
        ? 'Could not sync: ' + st.message
        : 'Every change here is uploaded straight away, and the quiz page downloads the latest questions before answering.' +
          (when ? ' Last synced at ' + when + '.' : '') +
          (info.pending ? ' ' + info.pending + ' change(s) waiting to upload.' : '') +
          (info.builtIn ? ' (Settings come from config.js.)' : '');

    const warn = $('tempWarn');
    warn.hidden = !isTemporary || (cloudOn && info.builtIn);
    warn.textContent = cloudOn
      ? 'This add-on is loaded temporarily: your questions are safe in the cloud, but Firefox forgets the connection when it restarts. Put the server address and access key in config.js to connect automatically.'
      : 'This add-on is loaded temporarily, so Firefox deletes these questions when it restarts. Turn on cloud sync below, click Export backup, or install the add-on permanently (see the README).';
  }

  async function syncNow() {
    $('syncMsg').textContent = 'Syncing with the cloud…';
    await send({ type: 'sync' });
    await reload();
    await renderSync();
  }

  async function init() {
    try {
      isTemporary = (await api.management.getSelf()).installType === 'development';
    } catch (e) {
      /* management API not available - skip the warning */
    }

    $('syncForm').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const info = (await send({ type: 'syncInfo' })) || {};
      const key = $('syncKey').value.trim();
      if (!key && !(info.hasKey && cloudOn)) return msg('Enter the access key.', 'warn');
      $('syncMsg').textContent = 'Connecting…';
      const r = await send({ type: 'connect', url: $('syncUrl').value, key: key || undefined });
      if (r && r.state === 'ok') {
        $('syncKey').value = '';
        msg('Connected to the cloud: ' + r.count + ' questions in your question bank.');
      } else {
        msg('Could not connect: ' + ((r && r.message) || 'unknown error'), 'warn');
      }
      await reload();
      await renderSync();
    });
    $('disconnectBtn').addEventListener('click', async () => {
      await send({ type: 'disconnect' });
      msg('Cloud sync turned off. The questions stay saved on this computer.');
      await renderSync();
    });
    $('syncNow').addEventListener('click', syncNow);
    $('lockBtn').hidden = !QuizLock.enabled();
    $('lockBtn').addEventListener('click', async () => {
      await QuizLock.lock();
      location.reload();
    });

    $('search').addEventListener('input', render);

    $('addBtn').addEventListener('click', () => {
      $('addPanel').hidden = false;
      $('importPanel').hidden = true;
      $('newQ').focus();
    });
    $('addCancel').addEventListener('click', () => ($('addPanel').hidden = true));
    $('addSave').addEventListener('click', async () => {
      const q = $('newQ').value.trim();
      const a = $('newA').value
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .join('\n');
      if (!q || !a) return msg('Both the question and the answer are needed.', 'warn');
      const r = B.merge(bank, [{ q, a }], 'manual');
      await B.save(api, r.bank);
      msg(r.added ? 'Question added.' : r.updated ? 'That question was already saved - its answer was updated.' : 'That question and answer were already saved.');
      $('newQ').value = '';
      $('newA').value = '';
      $('addPanel').hidden = true;
      await reload();
    });

    $('importBtn').addEventListener('click', () => {
      $('importPanel').hidden = false;
      $('addPanel').hidden = true;
      $('importText').focus();
    });
    $('importCancel').addEventListener('click', () => ($('importPanel').hidden = true));
    $('importFile').addEventListener('change', async () => {
      const f = $('importFile').files[0];
      if (f) $('importText').value = await f.text();
    });
    $('importSave').addEventListener('click', async () => {
      const text = $('importText').value;
      if (!text.trim()) return msg('Paste questions and answers, or choose a file first.', 'warn');
      const r = await B.addFromText(api, text, 'imported');
      if (!r.recognised) return msg('No questions recognised. Put each question on its own line with its answer below it.', 'warn');
      msg('Import: ' + B.summary(r) + '.');
      $('importText').value = '';
      $('importFile').value = '';
      $('importPanel').hidden = true;
      await reload();
    });

    $('exportBtn').addEventListener('click', () => {
      if (!bank.length) return msg('Nothing to export yet.', 'warn');
      const blob = new Blob([B.toExport(bank)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'quiz-autopilot-bank-' + new Date().toISOString().slice(0, 10) + '.json';
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      msg('Backup saved to your downloads (' + bank.length + ' questions). Import it again with "Import…".');
    });

    $('undoBtn').addEventListener('click', async () => {
      msg((await B.undo(api)) ? 'Last change undone.' : 'Nothing to undo.');
      await reload();
    });

    api.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes.bank && editing == null) reload();
      if (changes.syncStatus || changes.pendingOps || changes.syncConfig) renderSync();
    });

    await reload();
    await renderSync();
    if (cloudOn) syncNow();
  }

  QuizLock.guard(init);
})();
