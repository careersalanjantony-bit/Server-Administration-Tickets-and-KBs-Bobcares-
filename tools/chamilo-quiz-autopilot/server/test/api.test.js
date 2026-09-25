// Run with: cd tools/chamilo-quiz-autopilot/server && npm test
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const TOKEN = 'test-key-123';

// Fake Upstash REST API (single command, /pipeline, /multi-exec) so the real
// Redis adapter is exercised without a network connection.
function fakeUpstash() {
  const hashes = new Map();
  const strings = new Map();
  const run = ([cmd, ...args]) => {
    switch (cmd.toUpperCase()) {
      case 'GET':
        return strings.has(args[0]) ? String(strings.get(args[0])) : null;
      case 'INCR': {
        const v = Number(strings.get(args[0]) || 0) + 1;
        strings.set(args[0], v);
        return v;
      }
      case 'HSET': {
        const h = hashes.get(args[0]) || new Map();
        hashes.set(args[0], h);
        let n = 0;
        for (let i = 1; i < args.length; i += 2) {
          if (!h.has(args[i])) n++;
          h.set(args[i], args[i + 1]);
        }
        return n;
      }
      case 'HDEL': {
        const h = hashes.get(args[0]) || new Map();
        return args.slice(1).filter((f) => h.delete(f)).length;
      }
      case 'HGETALL':
        return [...(hashes.get(args[0]) || new Map())].flat();
      case 'HMGET': {
        const h = hashes.get(args[0]) || new Map();
        return args.slice(1).map((f) => (h.has(f) ? h.get(f) : null));
      }
      default:
        throw new Error('unsupported ' + cmd);
    }
  };
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.headers.authorization !== 'Bearer upstash-token') {
        res.statusCode = 401;
        return res.end(JSON.stringify({ error: 'Unauthorized' }));
      }
      const cmd = JSON.parse(body);
      if (req.url === '/pipeline' || req.url === '/multi-exec') return res.end(JSON.stringify(cmd.map((c) => ({ result: run(c) }))));
      res.end(JSON.stringify({ result: run(cmd) }));
    });
  });
}

async function listen(server) {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return 'http://127.0.0.1:' + server.address().port;
}

let api;
let upstash;
test.before(async () => {
  upstash = fakeUpstash();
  process.env.UPSTASH_REDIS_REST_URL = await listen(upstash);
  process.env.UPSTASH_REDIS_REST_TOKEN = 'upstash-token';
  process.env.BANK_TOKEN = TOKEN;
  const questions = require('../api/questions.js');
  const health = require('../api/health.js');
  const server = http.createServer((req, res) => (req.url.startsWith('/api/health') ? health(req, res) : questions(req, res)));
  api = { server, base: await listen(server) };
});
test.after(() => {
  api.server.close();
  upstash.close();
});

const call = (method, path, body, key = TOKEN) =>
  fetch(api.base + path, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, key ? { Authorization: 'Bearer ' + key } : {}),
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, headers: r.headers, body: r.status === 204 ? null : await r.json() }));

test('health reports the setup', async () => {
  const r = await call('GET', '/api/health', null, null);
  assert.deepEqual(r.body, { ok: true, accessKey: 'set', database: 'connected' });
});

test('needs the access key, and answers CORS preflight', async () => {
  assert.equal((await call('GET', '/api/questions', null, null)).status, 401);
  assert.equal((await call('GET', '/api/questions', null, 'wrong')).status, 401);
  const pre = await call('OPTIONS', '/api/questions', null, null);
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), '*');
  assert.match(pre.headers.get('access-control-allow-headers'), /Authorization/);
});

test('upload, download, "nothing new", newer-answer-wins and delete', async () => {
  let r = await call('GET', '/api/questions');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.entries, []);

  r = await call('POST', '/api/questions', {
    upsert: [
      { key: 'which plan provides assistance with anydesk', q: 'Which plan provides assistance with AnyDesk?', a: 'Dedicated Engineer Session or PLSM', updated: 1000 },
      { key: 'lsm plan websites', q: 'How many websites can be monitored in LSM plan', a: '3', updated: 1000 },
      { key: 'bad entry without answer', q: 'x' },
    ],
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.entries.length, 2, 'invalid entry skipped');
  const rev = r.body.rev;

  r = await call('GET', '/api/questions?rev=' + rev);
  assert.deepEqual(r.body, { rev, unchanged: true });

  // An older edit from another computer does not overwrite a newer answer.
  r = await call('POST', '/api/questions', { upsert: [{ key: 'lsm plan websites', q: 'How many websites can be monitored in LSM plan', a: '5', updated: 500 }] });
  assert.equal(r.body.entries.find((e) => e.key === 'lsm plan websites').a, '3');
  // A newer one does.
  r = await call('POST', '/api/questions', { upsert: [{ key: 'lsm plan websites', q: 'How many websites can be monitored in LSM plan', a: '3 websites', updated: 2000 }] });
  assert.equal(r.body.entries.find((e) => e.key === 'lsm plan websites').a, '3 websites');

  r = await call('POST', '/api/questions', { delete: ['lsm plan websites'] });
  assert.deepEqual(r.body.entries.map((e) => e.key), ['which plan provides assistance with anydesk']);
  assert.ok(r.body.rev > rev);
});
