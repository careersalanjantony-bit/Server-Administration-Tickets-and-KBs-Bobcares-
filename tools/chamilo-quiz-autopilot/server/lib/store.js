/*
 * Where the question bank lives.
 *
 * Production: Upstash Redis (add it in Vercel -> Storage; Vercel then sets
 * KV_REST_API_URL / KV_REST_API_TOKEN, or UPSTASH_REDIS_REST_URL / _TOKEN).
 * Talks to Upstash over its REST API with fetch, so no npm packages are needed.
 *
 * Local testing: BANK_STORE=memory keeps everything in memory.
 *
 * Data: one Redis hash (field = question key, value = JSON entry) plus a
 * revision counter that goes up on every change, so clients can ask
 * "anything new since revision N?" cheaply.
 */
'use strict';

const PREFIX = process.env.BANK_NAME || 'quiz-autopilot';
const HASH = PREFIX + ':bank';
const REV = PREFIX + ':rev';

function parseEntries(flat) {
  const entries = [];
  for (let i = 0; i + 1 < (flat || []).length; i += 2) {
    try {
      entries.push(JSON.parse(flat[i + 1]));
    } catch (e) {
      /* skip a damaged value */
    }
  }
  return entries;
}

function redisStore(url, token) {
  const base = url.replace(/\/+$/, '');
  async function call(path, body) {
    const res = await fetch(base + path, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    let data = null;
    try {
      data = await res.json();
    } catch (e) {
      /* handled below */
    }
    if (!res.ok || !data || data.error) throw new Error('Database error: ' + ((data && data.error) || res.status));
    if (Array.isArray(data)) {
      const bad = data.find((r) => r && r.error);
      if (bad) throw new Error('Database error: ' + bad.error);
    }
    return data;
  }
  return {
    kind: 'upstash-redis',
    async rev() {
      return Number((await call('', ['GET', REV])).result || 0);
    },
    async all() {
      const [rev, all] = await call('/pipeline', [['GET', REV], ['HGETALL', HASH]]);
      return { rev: Number(rev.result || 0), entries: parseEntries(all.result) };
    },
    async get(keys) {
      if (!keys.length) return [];
      const { result } = await call('', ['HMGET', HASH].concat(keys));
      return (result || []).map((v) => (v ? JSON.parse(v) : null));
    },
    async write(puts, dels) {
      const cmds = [];
      if (puts.length) cmds.push(['HSET', HASH].concat(...puts));
      if (dels.length) cmds.push(['HDEL', HASH].concat(dels));
      cmds.push(['INCR', REV]);
      await call('/multi-exec', cmds);
    },
  };
}

// In-memory store for local testing (BANK_STORE=memory).
const memory = { map: new Map(), rev: 0 };
function memoryStore() {
  return {
    kind: 'memory',
    async rev() {
      return memory.rev;
    },
    async all() {
      return { rev: memory.rev, entries: [...memory.map.values()].map((v) => JSON.parse(v)) };
    },
    async get(keys) {
      return keys.map((k) => (memory.map.has(k) ? JSON.parse(memory.map.get(k)) : null));
    },
    async write(puts, dels) {
      for (const [k, v] of puts) memory.map.set(k, v);
      for (const k of dels) memory.map.delete(k);
      memory.rev++;
    },
    reset() {
      memory.map.clear();
      memory.rev = 0;
    },
  };
}

function getStore() {
  if (process.env.BANK_STORE === 'memory') return memoryStore();
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  return redisStore(url, token);
}

module.exports = { getStore };
