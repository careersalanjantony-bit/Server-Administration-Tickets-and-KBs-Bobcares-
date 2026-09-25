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
        }),
        button('Delete', '', () => remove(e.id))
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

  async function remove(id) {
    await B.save(
      api,
      bank.filter((e) => e.id !== id)
    );
    msg('Question deleted. Use "Undo last change" to bring it back.');
    await reload();
  }

  async function init() {
    try {
      const self = await api.management.getSelf();
      $('tempWarn').hidden = self.installType !== 'development';
    } catch (e) {
      /* management API not available - skip the warning */
    }

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

    $('clearBtn').addEventListener('click', async () => {
      if (!bank.length) return;
      if (!window.confirm('Delete all ' + bank.length + ' saved questions? You can still use "Undo last change" right after.')) return;
      await B.save(api, []);
      msg('All questions deleted. Use "Undo last change" to bring them back.');
      await reload();
    });

    api.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.bank && editing == null) reload();
    });

    await reload();
  }

  init();
})();
