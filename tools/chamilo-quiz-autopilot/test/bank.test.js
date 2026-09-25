// Run with: node --test tools/chamilo-quiz-autopilot/test/bank.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
global.QuizMatcher = require('../matcher.js');
const B = require('../bank.js');

// Minimal stand-in for browser.storage.local.
function fakeApi(initial) {
  const store = Object.assign({}, initial);
  return {
    store,
    storage: {
      local: {
        async get(defs) {
          const out = {};
          for (const k of Object.keys(defs)) out[k] = k in store ? JSON.parse(JSON.stringify(store[k])) : defs[k];
          return out;
        },
        async set(obj) {
          Object.assign(store, JSON.parse(JSON.stringify(obj)));
        },
      },
    },
  };
}

test('merge adds new questions, updates changed answers and skips duplicates', () => {
  const first = B.merge([], [
    { q: '1. Which plan provides assistance with AnyDesk?', a: 'Dedicated Engineer Session or PLSM' },
    { q: 'Which is not a billable task in PSM?', a: 'Server hack' },
  ], 'pasted', 1000);
  assert.equal(first.added, 2);
  assert.equal(first.bank[0].q, 'Which plan provides assistance with AnyDesk?'); // numbering dropped

  const second = B.merge(first.bank, [
    { q: 'which plan provides assistance with anydesk', a: 'dedicated engineer session or PLSM.' }, // same Q, same A
    { q: 'Which is not a billable task in PSM?', a: 'Server hack (not billable)' }, // same Q, new A
    { q: 'How many websites can be monitored in LSM plan', a: '3' }, // new
  ], 'pasted', 2000);
  assert.deepEqual([second.added, second.updated, second.unchanged], [1, 1, 1]);
  assert.equal(second.bank.length, 3);
  const updated = second.bank.find((e) => e.q.startsWith('Which is not'));
  assert.equal(updated.a, 'Server hack (not billable)');
  assert.equal(updated.prev, 'Server hack');
  assert.equal(updated.added, 1000);
  assert.equal(updated.updated, 2000);
  assert.equal(first.bank[1].a, 'Server hack', 'input bank is not modified');
  assert.equal(B.summary(second), '1 added, 1 updated, 1 already saved');
});

test('pasting text adds to the saved bank, and undo restores the previous bank', async () => {
  const api = fakeApi();
  let r = await B.addFromText(api, '1. Which plan provides assistance with AnyDesk?\nAnswer: Dedicated Engineer Session or PLSM', 'pasted');
  assert.deepEqual([r.recognised, r.added], [1, 1]);
  r = await B.addFromText(api, '### 2. How many websites can be monitored in LSM plan\n\n**Answer:** 3', 'pasted');
  assert.equal(r.added, 1);
  assert.equal((await B.load(api)).length, 2);

  assert.equal(await B.undo(api), true);
  assert.equal((await B.load(api)).length, 1);
});

test('an old pasted answer key is moved into the bank once', async () => {
  const api = fakeApi({ answerKey: 'Q: Which plan provides assistance with AnyDesk?\nA: Dedicated Engineer Session or PLSM' });
  const bank = await B.load(api);
  assert.equal(bank.length, 1);
  assert.equal(api.store.answerKey, '');
  assert.equal((await B.load(api)).length, 1);
});

test('backup export can be imported again', () => {
  const { bank } = B.merge([], [
    { q: 'Match following tasks in order of priority', a: '1. Priority Chats\n2. Priority Tickets' },
    { q: 'For IST support server, how to login to server', a: 'Duo App' },
  ], 'manual');
  const entries = B.parseAny(B.toExport(bank));
  assert.deepEqual(entries.map((e) => [e.q, e.a]), bank.map((e) => [e.q, e.a]));
  const again = B.merge([], entries, 'imported');
  assert.equal(again.added, 2);
  assert.equal(again.bank[0].source, 'manual', 'original label kept');
  assert.equal(again.bank[0].added, bank[0].added, 'original date kept');
});
