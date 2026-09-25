/*
 * Quiz Autopilot - the question bank (saved questions and answers).
 *
 * Merge logic is pure so it can be unit-tested in Node; the storage helpers
 * take the WebExtension API object (`browser`) as an argument.
 *
 * Stored in browser.storage.local:
 *   bank        [{ id, q, a, qx?, source, added, updated, prev? }]
 *   bankBackup  the bank as it was before the last change (for "Undo")
 */
(function (root) {
  'use strict';

  const M = root.QuizMatcher || (typeof require !== 'undefined' ? require('./matcher.js') : null);

  // Two questions are "the same" when their letters and digits match
  // (case, punctuation and "12." numbering are ignored).
  function keyOf(q) {
    return M.norm(q).replace(/[^a-z0-9]+/g, ' ').trim();
  }

  const sameAnswer = (a, b) => keyOf(a) === keyOf(b);

  function newId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  /**
   * Add new questions and update the answers of ones already in the bank.
   * @returns {{ bank, added, updated, unchanged }}  (the input bank is not modified)
   */
  function merge(bank, incoming, source, now) {
    now = now || Date.now();
    const out = (bank || []).map((e) => Object.assign({}, e));
    const index = new Map(out.map((e, i) => [keyOf(e.q), i]));
    let added = 0;
    let updated = 0;
    let unchanged = 0;
    for (const e of incoming || []) {
      const q = M.clean(e && e.q).replace(/^\s*(?:q(?:uestion)?\s*)?\d+\s*[.):]\s+/i, '');
      const a = String((e && e.a) || '').trim();
      const k = keyOf(q);
      if (!k || !a) continue;
      const i = index.get(k);
      if (i == null) {
        // A backup keeps each question's original label and dates.
        const since = e.added || now;
        const entry = { id: newId(), q, a, source: e.source || source || 'pasted', added: since, updated: e.updated || since };
        if (e.qx) entry.qx = e.qx;
        index.set(k, out.push(entry) - 1);
        added++;
      } else if (!sameAnswer(out[i].a, a)) {
        out[i] = Object.assign({}, out[i], { a, prev: out[i].a, updated: now, source: source || out[i].source });
        if (e.qx) out[i].qx = e.qx;
        updated++;
      } else {
        unchanged++;
      }
    }
    return { bank: out, added, updated, unchanged };
  }

  function summary(r) {
    const parts = [];
    if (r.added) parts.push(r.added + ' added');
    if (r.updated) parts.push(r.updated + ' updated');
    if (r.unchanged) parts.push(r.unchanged + ' already saved');
    return parts.join(', ') || 'nothing new';
  }

  // ---- backup file

  function toExport(bank) {
    return JSON.stringify(
      {
        format: 'quiz-autopilot-bank',
        version: 1,
        exported: new Date().toISOString(),
        entries: bank.map((e) => {
          const o = { q: e.q, a: e.a };
          if (e.qx) o.qx = e.qx;
          if (e.source) o.source = e.source;
          if (e.added) o.added = e.added;
          if (e.updated) o.updated = e.updated;
          return o;
        }),
      },
      null,
      2
    );
  }

  // Entries from a backup file or any pasted text (all formats parseKey reads).
  function parseAny(text) {
    const t = String(text || '').trim();
    if (/^\{/.test(t)) {
      try {
        const data = JSON.parse(t);
        if (data && Array.isArray(data.entries)) {
          return data.entries
            .filter((e) => e && e.q && e.a)
            .map((e) => ({ q: String(e.q), a: String(e.a), qx: e.qx, source: e.source, added: e.added, updated: e.updated }));
        }
      } catch (err) {
        /* not a backup file - fall through */
      }
    }
    return M.parseKey(t);
  }

  // ---- cloud sync helpers (pure)

  // What the server stores for one question.
  function wireEntry(e) {
    const o = { key: keyOf(e.q), q: e.q, a: e.a, source: e.source || 'pasted', added: e.added || Date.now(), updated: e.updated || e.added || Date.now() };
    if (e.qx) o.qx = e.qx;
    return o;
  }

  function fromServer(entries) {
    return (entries || []).map((e) => {
      const o = { id: e.key, q: e.q, a: e.a, source: e.source, added: e.added, updated: e.updated };
      if (e.qx) o.qx = e.qx;
      return o;
    });
  }

  // The uploads needed to turn bank `from` into bank `to`.
  function diffOps(from, to) {
    const before = new Map((from || []).map((e) => [keyOf(e.q), e]));
    const after = new Map((to || []).map((e) => [keyOf(e.q), e]));
    const ops = [];
    for (const [key, e] of after) {
      const old = before.get(key);
      if (!old || old.a !== e.a || old.q !== e.q || (old.qx || '') !== (e.qx || '')) ops.push({ op: 'upsert', key, entry: wireEntry(e) });
    }
    for (const key of before.keys()) if (!after.has(key)) ops.push({ op: 'delete', key });
    return ops;
  }

  // Local changes not uploaded yet, applied on top of what the server sent.
  function applyOps(bank, pending) {
    const out = new Map((bank || []).map((e) => [keyOf(e.q), e]));
    for (const o of Object.values(pending || {})) {
      if (o.op === 'delete') out.delete(o.key);
      else if (o.entry) out.set(o.key, fromServer([o.entry])[0]);
    }
    return [...out.values()];
  }

  // ---- storage (browser only)
  //   bank, bankBackup (for Undo), pendingOps { key: { op, key, entry?, t } } (not uploaded yet)

  async function queue(api, ops) {
    if (!ops.length) return;
    const { pendingOps } = await api.storage.local.get({ pendingOps: {} });
    const t = Date.now();
    for (const o of ops) pendingOps[o.key] = Object.assign({}, o, { t });
    await api.storage.local.set({ pendingOps });
  }

  // Replace the bank with `bank` (keeping the old one for Undo) and queue the uploads.
  async function commit(api, current, bank) {
    const ops = diffOps(current, bank);
    await api.storage.local.set({ bank, bankBackup: current });
    await queue(api, ops);
  }

  // Load the bank; the first time, move an old pasted answer key into it.
  async function load(api) {
    const st = await api.storage.local.get({ bank: [], answerKey: '' });
    if (!st.bank.length && st.answerKey) {
      const r = merge([], M.parseKey(st.answerKey), 'pasted');
      await api.storage.local.set({ answerKey: '' });
      await commit(api, [], r.bank);
      return r.bank;
    }
    return st.bank;
  }

  // Save a new bank, keeping the previous one for "Undo".
  async function save(api, bank) {
    await commit(api, await load(api), bank);
  }

  // Upload everything this computer has (used when connecting to the cloud).
  async function queueAll(api) {
    await queue(api, diffOps([], await load(api)));
  }

  async function addFromText(api, text, source) {
    const incoming = parseAny(text);
    const r = merge(await load(api), incoming, source);
    r.recognised = incoming.length;
    if (r.added || r.updated) await save(api, r.bank);
    return r;
  }

  async function undo(api) {
    const st = await api.storage.local.get({ bank: [], bankBackup: null });
    if (!st.bankBackup) return false;
    await commit(api, st.bank, st.bankBackup);
    return true;
  }

  const api = { keyOf, merge, summary, toExport, parseAny, wireEntry, fromServer, diffOps, applyOps, load, save, queueAll, addFromText, undo };
  root.QuizBank = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
