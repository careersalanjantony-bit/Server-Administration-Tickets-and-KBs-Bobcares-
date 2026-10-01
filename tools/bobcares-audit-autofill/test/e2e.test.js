// End-to-end test in Chromium against the mock audit pages in test/mock/.
//
// Run with:  NODE_PATH="$(npm root -g)" node --test tools/bobcares-audit-autofill/test/e2e.test.js
// Needs Playwright with Chromium (npm i -g playwright && npx playwright install chromium); skipped otherwise.
// AUDIT_REFERENCE=/path/to/screenshot.png uses a real View Server Audit screenshot as the reference
// instead of a screenshot of test/mock/view.html (its rows must match the mock's states, see REF_STATES).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

let chromium = null;
try {
  ({ chromium } = require('playwright'));
} catch {
  chromium = null;
}

const DIR = path.join(__dirname, '..');
const EDIT_URL = 'https://portal.bobcares.com/bob_Portal/server-audit/264/edit/12182';
const VIEW_URL = 'https://portal.bobcares.com/bob_Portal/server/264/audits/11950';
// Previous month (reference). The edit page starts half done: GGGGG, GGGGGGG, YYYYYYY, GGGNGGG, GYYY, YYYYYYYY
// (see START in test/mock/edit.html), so only Server Health and five Proactive Defence items need marking.
const REF_STATES = 'GGGGG,GGGGGGG,GGGGGGG,GGGNGGG,GRRR,GGGRGRGR';
const EXPECTED_TICKS = [
  'Server Uptime', 'HTTP Uptime', 'CPU Usage', 'RAM Usage', 'Disc Space Usage', 'Email Queue', 'IP Reputation',
  '/tmp Security', 'Reboot Procedure', 'IP RDNS', 'Rootkit Check', 'PHP Functions Security',
];
const EXPECTED_END = ['GGGGG', 'GGGGGGG', 'GGGGGGG', 'GGGNGGG', 'GYYY', 'GGGYGYGY'];

// browser.storage / runtime stand-in, kept in the page's localStorage so it survives reloads like the real one.
const STUB = `
(() => {
  const KEY = '__ext_storage';
  const read = () => JSON.parse(localStorage.getItem(KEY) || '{}');
  window.browser = {
    storage: {
      local: {
        get: async (defaults) => {
          const s = read();
          const out = {};
          for (const k of Object.keys(defaults || {})) out[k] = k in s ? s[k] : defaults[k];
          return out;
        },
        set: async (obj) => {
          const s = read();
          Object.assign(s, JSON.parse(JSON.stringify(obj)));
          localStorage.setItem(KEY, JSON.stringify(s));
        },
      },
    },
    runtime: { onMessage: { addListener: (fn) => { window.__extOnMessage = fn; } } },
  };
})();`;
const SCRIPTS = ['analyzer.js', 'page.js', 'content.js'].map((f) => fs.readFileSync(path.join(DIR, f), 'utf8')).join('\n;\n');
const INIT = STUB + "\ndocument.addEventListener('DOMContentLoaded', () => setTimeout(() => {\n" + SCRIPTS + '\n}, 0));';

async function newContext(browser) {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await context.route('https://portal.bobcares.com/**', (route) => {
    const file = new URL(route.request().url()).pathname.includes('/edit/') ? 'edit.html' : 'view.html';
    route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(__dirname, 'mock', file)) });
  });
  await context.addInitScript(INIT);
  return context;
}

async function referenceImage(context) {
  if (process.env.AUDIT_REFERENCE) {
    const file = process.env.AUDIT_REFERENCE;
    const ext = path.extname(file).slice(1).replace('jpg', 'jpeg');
    return { name: path.basename(file), mimeType: 'image/' + ext, buffer: fs.readFileSync(file) };
  }
  const view = await context.newPage();
  await view.goto(VIEW_URL + '?states=' + REF_STATES);
  const buffer = await view.screenshot({ fullPage: true });
  await view.close();
  return { name: 'reference.png', mimeType: 'image/png', buffer };
}

async function openEditPage(context, query, settings) {
  const page = await context.newPage();
  await page.goto(EDIT_URL + query);
  await page.evaluate((st) => {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('__ext_storage', JSON.stringify({ settings: st }));
  }, Object.assign({ keywords: 'Active, Enabled', delayMs: 200, skipDone: true, details: '' }, settings));
  await page.reload();
  await page.locator('#launcher').click();
  return page;
}

async function ticked(page) {
  await page.locator('#plan .sec').first().waitFor();
  return page
    .locator('#plan .item')
    .evaluateAll((rows) => rows.filter((r) => r.querySelector('input').checked).map((r) => r.querySelectorAll('label > span')[1].textContent));
}

// Polls through page reloads (Submit reloads the page in mode=reload).
async function waitForStatus(page, re, timeout) {
  const end = Date.now() + (timeout || 60000);
  let last = '';
  while (Date.now() < end) {
    try {
      last = await page.evaluate(() => {
        const h = document.getElementById('bobcares-audit-autofill-host');
        const s = h && h.shadowRoot.querySelector('#status');
        return s ? s.textContent : '';
      });
      if (re.test(last)) return last;
    } catch {
      // page is reloading
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('Timed out waiting for ' + re + '; last status: ' + last);
}

const pageState = (page) =>
  page.evaluate(() => ({
    state: JSON.parse(localStorage.getItem('mockAudit') || 'null'),
    submissions: JSON.parse(localStorage.getItem('mockSubmissions') || '[]'),
  }));

test('end to end', { skip: !chromium && 'playwright is not installed' }, async (t) => {
  const browser = await chromium.launch();
  t.after(() => browser.close());

  for (const [variant, mode] of [['a', 'reload'], ['a', 'ajax'], ['b', 'ajax'], ['b', 'reload']]) {
    await t.test('marks the previously green items Active (variant ' + variant + ', ' + mode + ')', async () => {
      const context = await newContext(browser);
      const ref = await referenceImage(context);
      const page = await openEditPage(context, '?variant=' + variant + '&mode=' + mode);
      await page.locator('#file').setInputFiles(ref);
      assert.deepEqual(await ticked(page), EXPECTED_TICKS);
      assert.equal(await page.locator('#apply').textContent(), 'Mark 12 items Active');

      await page.locator('#apply').click();
      const status = await waitForStatus(page, /^(Done|Stopped)/, 90000);
      assert.match(status, /^Done\. 12 marked Active\.$/);

      const { state, submissions } = await pageState(page);
      assert.deepEqual(state.map((s) => s.join('')), EXPECTED_END);
      assert.equal(submissions.length, 12);
      for (const sub of submissions) {
        assert.equal(sub.status, '1', 'picked Active');
        assert.equal(sub.rec, '0', 'recommendation left at No');
        assert.equal(sub.details, '', 'details left empty');
      }
      await context.close();
    });
  }

  await t.test('dry run opens each item but saves nothing', async () => {
    const context = await newContext(browser);
    const ref = await referenceImage(context);
    const page = await openEditPage(context, '?variant=a&mode=ajax');
    await page.locator('#file').setInputFiles(ref);
    await ticked(page);
    await page.locator('#dry').click();
    const status = await waitForStatus(page, /^(Done|Stopped)/, 60000);
    assert.match(status, /^Done\. 12 checked \(dry run, nothing saved\)\.$/);
    const { state, submissions } = await pageState(page);
    assert.equal(state, null);
    assert.equal(submissions.length, 0);
    await context.close();
  });

  await t.test('unticked items and a missing option name are left alone', async () => {
    const context = await newContext(browser);
    const ref = await referenceImage(context);
    const page = await openEditPage(context, '?variant=a&mode=ajax', { keywords: 'Enabled', details: 'Checked, all fine.' });
    await page.locator('#file').setInputFiles(ref);
    await ticked(page);
    // Untick the whole Server Health card, keep Proactive Defence (5 items).
    await page.locator('#plan .sec').nth(2).locator('button', { hasText: 'none' }).click();
    assert.equal(await page.locator('#apply').textContent(), 'Mark 5 items Active');
    await page.locator('#apply').click();
    const status = await waitForStatus(page, /^(Done|Stopped)/, 60000);
    assert.match(status, /5 failed/);
    const fails = await page.locator('#results td.r.failed').count();
    assert.equal(fails, 5);
    assert.match(await page.locator('#results').textContent(), /no "Enabled" option in the dialog \(found: Active, Inactive\)/);
    const { state, submissions } = await pageState(page);
    assert.equal(state, null);
    assert.equal(submissions.length, 0);
    await context.close();
  });

  await t.test('a run stays in its own tab', async () => {
    const context = await newContext(browser);
    const ref = await referenceImage(context);
    const page = await openEditPage(context, '?variant=a&mode=reload', { delayMs: 600 });
    await page.locator('#file').setInputFiles(ref);
    await ticked(page);
    await page.locator('#apply').click();
    await waitForStatus(page, /Marking items Active: 2 \//, 30000);
    // Another portal tab opened mid-run: not redirected to the audit, no panel.
    const other = await context.newPage();
    await other.goto(VIEW_URL);
    await other.waitForTimeout(1500);
    assert.equal(other.url(), VIEW_URL);
    assert.equal(await other.locator('.panel:not(.hidden)').count(), 0);
    await waitForStatus(page, /^(Done|Stopped)/, 90000);
    assert.equal((await pageState(page)).submissions.length, 12);
    await context.close();
  });

  await t.test('stop halts the run', async () => {
    const context = await newContext(browser);
    const ref = await referenceImage(context);
    const page = await openEditPage(context, '?variant=a&mode=reload', { delayMs: 1500 });
    await page.locator('#file').setInputFiles(ref);
    await ticked(page);
    await page.locator('#apply').click();
    await waitForStatus(page, /Marking items Active: 2 \//, 30000);
    await page.locator('#stop').click();
    const status = await waitForStatus(page, /^(Done|Stopped)/, 30000);
    assert.match(status, /^Stopped\./);
    const { submissions } = await pageState(page);
    assert.ok(submissions.length >= 2 && submissions.length <= 3, 'stopped after ' + submissions.length);
    await context.close();
  });
});
