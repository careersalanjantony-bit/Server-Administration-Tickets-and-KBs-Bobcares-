/*
 * /api/questions - the shared question bank.
 *
 *   GET  /api/questions            -> { rev, entries: [{ key, q, a, qx?, source, added, updated }] }
 *   GET  /api/questions?rev=N      -> { rev, unchanged: true } when nothing changed since N
 *   POST /api/questions            body { upsert: [entry...], delete: [key...] } -> { rev, entries }
 *
 * Every request needs "Authorization: Bearer <BANK_TOKEN>".
 * When two computers change the same question, the newer answer ("updated") wins.
 */
'use strict';

const { getStore } = require('../lib/store');
const { cors, send, readJson, authorized, query } = require('../lib/http');

const MAX_ENTRIES = 5000;
const str = (v, max) => (typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : null);
const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);

function validEntry(e) {
  if (!e || typeof e !== 'object') return null;
  const key = str(e.key, 1000);
  const q = str(e.q, 5000);
  const a = str(e.a, 20000);
  if (!key || !q || !a) return null;
  const now = Date.now();
  const out = { key, q, a, source: str(e.source, 40) || 'pasted', added: num(e.added) || now, updated: num(e.updated) || now };
  const qx = str(e.qx, 10000);
  if (qx) out.qx = qx;
  return out;
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }
  if (!process.env.BANK_TOKEN) {
    return send(res, 500, { error: 'Server not set up yet: add a BANK_TOKEN environment variable in Vercel and redeploy.' });
  }
  if (!authorized(req)) return send(res, 401, { error: 'Wrong access key.' });
  const store = getStore();
  if (!store) {
    return send(res, 500, { error: 'No database connected: in Vercel open Storage, add Upstash Redis to this project and redeploy.' });
  }

  try {
    if (req.method === 'GET') {
      const since = query(req).get('rev');
      if (since !== null && since !== '') {
        const rev = await store.rev();
        if (Number(since) === rev) return send(res, 200, { rev, unchanged: true });
      }
      return send(res, 200, await store.all());
    }

    if (req.method === 'POST') {
      let body;
      try {
        body = await readJson(req);
      } catch (e) {
        return send(res, 400, { error: 'Body must be JSON.' });
      }
      const upsert = (Array.isArray(body.upsert) ? body.upsert : []).map(validEntry).filter(Boolean);
      const dels = (Array.isArray(body.delete) ? body.delete : []).map((k) => str(k, 1000)).filter(Boolean);
      if (upsert.length + dels.length > MAX_ENTRIES) return send(res, 413, { error: 'Too many changes in one request.' });

      // Keep the newer answer when another computer already saved a later one.
      const current = await store.get(upsert.map((e) => e.key));
      const puts = upsert.filter((e, i) => !(current[i] && current[i].updated > e.updated)).map((e) => [e.key, JSON.stringify(e)]);
      if (puts.length || dels.length) {
        const { entries } = await store.all();
        const known = new Set(entries.map((e) => e.key));
        const growth = puts.filter(([k]) => !known.has(k)).length;
        if (entries.length + growth > MAX_ENTRIES) return send(res, 413, { error: 'The question bank is full (' + MAX_ENTRIES + ' questions).' });
        await store.write(puts, dels);
      }
      return send(res, 200, await store.all());
    }

    return send(res, 405, { error: 'Method not allowed.' });
  } catch (err) {
    return send(res, 502, { error: String((err && err.message) || err) });
  }
};
