// Run with: node --test tools/bobcares-audit-autofill/test/analyzer.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../analyzer.js');

// ---- tiny RGBA painter for synthetic screenshots

const BLUE = [12, 113, 195];
const NAVY = [30, 58, 138];
const CHECK = [47, 94, 58];
const CROSS = [184, 60, 68];
const GREY_DOT = [136, 148, 160];
const YELLOW = [233, 210, 72];
const TEXT = [82, 95, 127];
const DOT_GREEN = [45, 206, 137];
const BUTTON = [29, 90, 46];

function image(W, H) {
  return { width: W, height: H, data: new Uint8ClampedArray(W * H * 4).fill(255) };
}

function put(img, x, y, c) {
  x = Math.round(x);
  y = Math.round(y);
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
  const p = (y * img.width + x) * 4;
  img.data[p] = c[0];
  img.data[p + 1] = c[1];
  img.data[p + 2] = c[2];
}

function rect(img, x, y, w, h, c) {
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) put(img, x + i, y + j, c);
}

function disc(img, cx, cy, r, c) {
  for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) if (x * x + y * y <= r * r) put(img, cx + x, cy + y, c);
}

function line(img, x0, y0, x1, y1, t, c) {
  const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2);
  for (let i = 0; i <= steps; i++) disc(img, x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps, t / 2, c);
}

function eye(img, cx, cy, s) {
  for (let y = -s; y <= s; y++) {
    for (let x = -2 * s; x <= 2 * s; x++) {
      const e = (x * x) / (4 * s * s) + (y * y) / (s * s);
      if (e <= 1) put(img, cx + x, cy + y, BLUE);
    }
  }
  disc(img, cx, cy, Math.round(s * 0.5), [255, 255, 255]);
}

/**
 * Draws an audit page: a navy banner, a blue info-table header with a legend,
 * and six section cards in a 3x2 grid.
 * states: one string per section, one letter per row (G ✓, R ✗, N NA dot, Y not done).
 * kind 'view': status icon + eye on the right.  kind 'edit': coloured dot on the left + green edit button.
 */
function auditPage(states, kind, k) {
  k = k || 1;
  const W = Math.round(1240 * k);
  const H = Math.round(900 * k);
  const img = image(W, H);
  rect(img, 0, 0, W, 50 * k, NAVY);
  rect(img, 450 * k, 70 * k, 340 * k, 26 * k, BLUE); // info table header
  disc(img, 470 * k, 130 * k, 3 * k, DOT_GREEN); // legend
  disc(img, 560 * k, 130 * k, 3 * k, CROSS);
  disc(img, 650 * k, 130 * k, 3 * k, GREY_DOT);
  disc(img, 740 * k, 130 * k, 3 * k, YELLOW);
  const cardW = 360 * k;
  const barH = 28 * k;
  const pitch = 30 * k;
  states.forEach((st, s) => {
    const x0 = (40 + (s % 3) * 400) * k;
    const top = (170 + Math.floor(s / 3) * 340) * k;
    rect(img, x0, top, cardW, barH, BLUE);
    rect(img, x0 + 12 * k, top + 10 * k, 90 * k, 8 * k, [255, 255, 255]); // header text
    [...st].forEach((c, i) => {
      const cy = top + barH + pitch * i + pitch / 2;
      rect(img, x0, top + barH + pitch * (i + 1) - 1, cardW, 1, [233, 236, 239]); // separator
      rect(img, x0 + (kind === 'edit' ? 28 : 16) * k, cy - 3 * k, (60 + i * 7) * k, 6 * k, TEXT); // label
      const ix = x0 + cardW - 42 * k;
      if (kind === 'edit') {
        const color = { G: DOT_GREEN, R: CROSS, N: GREY_DOT, Y: YELLOW }[c];
        disc(img, x0 + 14 * k, cy, 3 * k, color);
        rect(img, x0 + cardW - 40 * k, cy - 9 * k, 18 * k, 18 * k, BUTTON);
      } else {
        if (c === 'G') {
          line(img, ix - 5 * k, cy, ix - 1 * k, cy + 4 * k, 2 * k, CHECK);
          line(img, ix - 1 * k, cy + 4 * k, ix + 6 * k, cy - 5 * k, 2 * k, CHECK);
        } else if (c === 'R') {
          line(img, ix - 4 * k, cy - 4 * k, ix + 4 * k, cy + 4 * k, 2 * k, CROSS);
          line(img, ix + 4 * k, cy - 4 * k, ix - 4 * k, cy + 4 * k, 2 * k, CROSS);
        } else if (c === 'N') {
          disc(img, ix, cy, 2 * k, GREY_DOT);
        } else if (c === 'Y') {
          disc(img, ix, cy, 4 * k, YELLOW);
        }
        eye(img, x0 + cardW - 20 * k, cy, 4 * k);
      }
    });
  });
  return img;
}

const read = (a) => a.sections.map((s) => s.rows.map((r) => ({ green: 'G', red: 'R', na: 'N', yellow: 'Y', unknown: '?' })[r.status]).join(''));

const REF = ['GGGGG', 'GGGGGGG', 'GGGGGGG', 'GGGNGGG', 'GRRR', 'GGGRGRGR'];

test('reads a View Server Audit screenshot section by section, in reading order', () => {
  const a = A.analyze(auditPage(REF, 'view'));
  assert.equal(a.mode, 'view');
  assert.deepEqual(read(a), REF);
  assert.deepEqual(a.warnings, []);
});

test('reads every status kind, including "not done"', () => {
  const states = ['GRNY', 'YYGG', 'NRGR', 'G', 'RRRRRRR', 'NNGG'];
  assert.deepEqual(read(A.analyze(auditPage(states, 'view'))), states);
});

test('works at other zoom levels', () => {
  for (const k of [0.75, 1.6, 2.5]) assert.deepEqual(read(A.analyze(auditPage(REF, 'view', k))), REF, 'scale ' + k);
});

test('reads a filled-in edit page screenshot from its coloured dots', () => {
  const states = ['GGGGG', 'GGGGGGG', 'YYYYYYY', 'GGGNGGG', 'GYYY', 'YYYRYYYY'];
  const a = A.analyze(auditPage(states, 'edit'));
  assert.equal(a.mode, 'edit');
  assert.deepEqual(read(a), states);
});

test('ignores the blue info table and the legend', () => {
  const a = A.analyze(auditPage(REF, 'view'));
  assert.equal(a.sections.length, 6);
  assert.ok(a.sections.every((s) => s.box.y0 > 150), 'no section from the table header');
});

test('a screenshot without audit sections gives a warning', () => {
  const a = A.analyze(image(400, 300));
  assert.equal(a.sections.length, 0);
  assert.equal(a.mode, 'none');
  assert.match(a.warnings[0], /No audit sections found/);
});

test('pixel classes', () => {
  assert.equal(A.classify(...BLUE), A.C.BLUE);
  assert.equal(A.classify(...CHECK), A.C.GREEN);
  assert.equal(A.classify(...CROSS), A.C.RED);
  assert.equal(A.classify(...GREY_DOT), A.C.GREY);
  assert.equal(A.classify(...YELLOW), A.C.YELLOW);
  assert.equal(A.classify(255, 255, 255), A.C.NONE);
});

// ---- matching to the page

const pageSections = (states) =>
  states.map((st, s) => ({ name: 'Section ' + (s + 1), items: [...st].map((c, i) => ({ label: 'Item ' + (s + 1) + '.' + (i + 1), state: c === 'G' ? 'green' : 'yellow' })) }));

test('ticks the items that were green in the screenshot and are not green yet', () => {
  const a = A.analyze(auditPage(REF, 'view'));
  const plan = A.matchToPage(a, pageSections(['GGGGG', 'GGGGGGG', 'YYYYYYY', 'GGGYGGG', 'GYYY', 'YYYYYYYY']));
  assert.equal(plan.toMark, 12);
  assert.deepEqual(plan.warnings, []);
  const marked = plan.sections.map((s) => s.items.map((i) => (i.mark ? 'x' : '.')).join(''));
  assert.deepEqual(marked, ['.....', '.......', 'xxxxxxx', '.......', '....', 'xxx.x.x.']);
  assert.equal(plan.sections[0].items[0].note, 'already active');
  // Weekly Backup was NA: not ticked even though it is "not done" on the page.
  assert.equal(plan.sections[3].items[3].ref, 'na');
  assert.equal(plan.sections[3].items[3].mark, false);
});

test('with skipDone off, already-green items are ticked too', () => {
  const a = A.analyze(auditPage(REF, 'view'));
  const plan = A.matchToPage(a, pageSections(REF), { skipDone: false });
  assert.equal(plan.toMark, 31);
});

test('a card whose row count differs is left alone and reported', () => {
  const a = A.analyze(auditPage(REF, 'view'));
  const ps = pageSections(['YYYYY', 'YYYYYYYY', 'YYYYYYY', 'YYYYYYY', 'YYYY', 'YYYYYYYY']);
  const plan = A.matchToPage(a, ps);
  assert.ok(plan.sections[1].mismatch);
  assert.ok(plan.sections[1].items.every((i) => !i.mark));
  assert.match(plan.warnings.join('\n'), /"Section 2": the screenshot shows 7 row\(s\), the page has 8/);
  assert.equal(plan.toMark, 5 + 7 + 6 + 1 + 5);
});

test('sections missing from the screenshot are left alone', () => {
  const a = A.analyze(auditPage(REF.slice(0, 3), 'view'));
  const plan = A.matchToPage(a, pageSections(['YYYYY', 'YYYYYYY', 'YYYYYYY', 'YYYYYYY', 'YYYY', 'YYYYYYYY']));
  assert.match(plan.warnings[0], /screenshot has 3 section\(s\), this page has 6/);
  assert.ok(plan.sections.slice(3).every((s) => s.items.every((i) => !i.mark && i.ref === 'missing')));
  assert.equal(plan.toMark, 19);
});
