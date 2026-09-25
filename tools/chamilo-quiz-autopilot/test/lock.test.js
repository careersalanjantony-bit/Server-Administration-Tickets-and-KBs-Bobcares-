// Run with: node --test tools/chamilo-quiz-autopilot/test/lock.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeHash } = require('../scripts/make-password.js');
const L = require('../lock.js');

function fakeApi() {
  const areas = { local: {}, session: {} };
  const area = (name) => ({
    async get(defs) {
      const out = {};
      for (const k of Object.keys(defs)) out[k] = k in areas[name] ? areas[name][k] : defs[k];
      return out;
    },
    async set(obj) {
      Object.assign(areas[name], obj);
    },
  });
  return { areas, storage: { local: area('local'), session: area('session') } };
}

test('no password configured: never locked', async () => {
  globalThis.QUIZ_AUTOPILOT_CONFIG = { passwordHash: '' };
  assert.equal(L.enabled(), false);
  assert.equal(await L.isUnlocked(fakeApi()), true);
});

test('right password unlocks until locked again; wrong one does not', async () => {
  globalThis.QUIZ_AUTOPILOT_CONFIG = { passwordHash: makeHash('Correct Horse 1!', 1000) };
  const api = fakeApi();
  assert.equal(L.enabled(), true);
  assert.equal(await L.isUnlocked(api), false);
  assert.deepEqual(await L.unlock('wrong', api), { ok: false, wait: 0 });
  assert.equal(await L.isUnlocked(api), false);
  assert.deepEqual(await L.unlock('Correct Horse 1!', api), { ok: true });
  assert.equal(await L.isUnlocked(api), true);
  await L.lock(api);
  assert.equal(await L.isUnlocked(api), false);
});

test('five wrong tries make you wait, even with the right password', async () => {
  globalThis.QUIZ_AUTOPILOT_CONFIG = { passwordHash: makeHash('pw', 1000) };
  const api = fakeApi();
  for (let i = 0; i < 4; i++) assert.equal((await L.unlock('nope', api)).wait, 0);
  const fifth = await L.unlock('nope', api);
  assert.ok(fifth.wait >= 29 && fifth.wait <= 30, 'waits 30 s');
  const blocked = await L.unlock('pw', api);
  assert.equal(blocked.ok, false);
  assert.ok(blocked.wait > 0);
});
