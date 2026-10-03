/*
 * Audit Autofill – reference screenshot analyser.
 *
 * Reads a screenshot of a Bobcares server audit and returns, for every section
 * card, the status of each row in order:
 *
 *   green  ✓ (Active / Enabled)      red     ✗ (Inactive / Disabled)
 *   na     grey dot (NA)             yellow  Not Done
 *
 * Two kinds of screenshot work:
 *   - "view"  the View Server Audit page (✓ / ✗ / • next to an eye icon)
 *   - "edit"  a filled-in audit edit page (coloured dot left of each label,
 *             green edit button on the right)
 *
 * Sections are found from the blue header bars and rows from the eye / edit
 * icons at the right of each card. No OCR is used, so it works at any zoom
 * level; rows are matched to the page by position (section, then row).
 *
 * Pure functions: used by the content script and by the Node tests.
 */
(function (root) {
  'use strict';

  const C = { NONE: 0, BLUE: 1, GREEN: 2, RED: 3, GREY: 4, YELLOW: 5 };

  // ------------------------------------------------------------- pixels

  function classify(r, g, b) {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    const v = max / 255;
    const s = max === 0 ? 0 : d / max;
    if (s < 0.17) return v >= 0.3 && v <= 0.8 ? C.GREY : C.NONE;
    let h;
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
    if (h < 0) h += 360;
    if (h >= 195 && h <= 230 && s >= 0.45 && v >= 0.4) return C.BLUE;
    if (h >= 85 && h <= 175 && s >= 0.3 && v >= 0.25) return C.GREEN;
    if ((h <= 15 || h >= 340) && s >= 0.4 && v >= 0.4) return C.RED;
    if (h >= 38 && h <= 62 && s >= 0.45 && v >= 0.55) return C.YELLOW;
    return C.NONE;
  }

  function classifyImage(img) {
    const { width, height, data } = img;
    const mask = new Uint8Array(width * height);
    for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
      if (data[p + 3] >= 128) mask[i] = classify(data[p], data[p + 1], data[p + 2]);
    }
    return mask;
  }

  const median = (arr) => {
    const s = arr.slice().sort((a, b) => a - b);
    return s.length ? s[Math.floor(s.length / 2)] : 0;
  };
  const xOverlap = (a, b) => Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);

  // ------------------------------------------------------------- header bars

  // Long horizontal runs of blue, stacked into rectangles. White header text
  // inside the bar is bridged by allowing short gaps in a run.
  function findBars(mask, W, H) {
    const minRun = Math.max(30, Math.round(W * 0.08));
    const gapTol = Math.max(3, Math.round(W * 0.006));
    let open = [];
    const closed = [];
    for (let y = 0; y < H; y++) {
      const row = y * W;
      const runs = [];
      for (let x = 0; x < W; ) {
        if (mask[row + x] !== C.BLUE) {
          x++;
          continue;
        }
        const start = x;
        let end = x;
        let gap = 0;
        for (x++; x < W; x++) {
          if (mask[row + x] === C.BLUE) {
            end = x;
            gap = 0;
          } else if (++gap > gapTol) break;
        }
        if (end - start + 1 >= minRun) runs.push([start, end]);
      }
      const next = [];
      for (const [a, b] of runs) {
        const bar = open.find(
          (o) => o.lastY !== y && Math.min(b, o.x1) - Math.max(a, o.x0) >= 0.8 * Math.min(b - a, o.x1 - o.x0)
        );
        if (bar) {
          bar.lastY = y;
          bar.y1 = y;
          bar.x0 = Math.min(bar.x0, a);
          bar.x1 = Math.max(bar.x1, b);
          bar.xs0.push(a);
          bar.xs1.push(b);
        } else {
          next.push({ y0: y, y1: y, lastY: y, x0: a, x1: b, xs0: [a], xs1: [b] });
        }
      }
      for (const o of open) {
        if (y - o.lastY <= 2) next.push(o);
        else closed.push(o);
      }
      open = next;
    }
    closed.push(...open);

    let bars = closed.map((o) => ({ x0: median(o.xs0), x1: median(o.xs1), y0: o.y0, y1: o.y1, rows: o.xs0.length }));
    // A bar split by a line of header text: merge the pieces again.
    bars.sort((a, b) => a.y0 - b.y0);
    const merged = [];
    for (const b of bars) {
      const prev = merged.find(
        (m) =>
          xOverlap(m, b) >= 0.8 * Math.min(m.x1 - m.x0, b.x1 - b.x0) &&
          b.y0 - m.y1 <= Math.max(3, 0.6 * Math.min(m.y1 - m.y0 + 1, b.y1 - b.y0 + 1))
      );
      if (prev) {
        prev.y1 = Math.max(prev.y1, b.y1);
        prev.rows += b.rows;
      } else merged.push({ ...b });
    }
    bars = merged.filter((b) => {
      const w = b.x1 - b.x0 + 1;
      const h = b.y1 - b.y0 + 1;
      return h >= 6 && w / h >= 4 && w / h <= 60 && b.rows >= 0.6 * h;
    });
    return bars;
  }

  // ------------------------------------------------------------- rows

  function countBox(mask, W, x0, x1, y0, y1) {
    const n = [0, 0, 0, 0, 0, 0];
    for (let y = y0; y <= y1; y++) {
      const row = y * W;
      for (let x = x0; x <= x1; x++) n[mask[row + x]]++;
    }
    return { blue: n[C.BLUE], green: n[C.GREEN], red: n[C.RED], grey: n[C.GREY], yellow: n[C.YELLOW] };
  }

  function sectionRows(img, mask, bar, yEnd) {
    const W = img.width;
    const barH = bar.y1 - bar.y0 + 1;
    const w = bar.x1 - bar.x0 + 1;
    const minIcon = Math.max(3, Math.round(barH * barH * 0.004));
    const bigButton = Math.max(20, Math.round(barH * barH * 0.1));
    const sx0 = bar.x0 + Math.round(w * 0.5);
    const sx1 = Math.min(W - 1, bar.x1);
    const yStart = bar.y1 + 1;

    // Bands of rows that hold blue / green / red pixels in the right half of the card.
    const bands = [];
    const gapRows = Math.max(1, Math.round(barH * 0.1));
    let cur = null;
    for (let y = yStart; y <= yEnd; y++) {
      const row = y * W;
      let hit = false;
      for (let x = sx0; x <= sx1; x++) {
        const c = mask[row + x];
        if (c === C.BLUE || c === C.GREEN || c === C.RED) {
          hit = true;
          break;
        }
      }
      if (hit) {
        if (cur && y - cur.y1 <= gapRows + 1) cur.y1 = y;
        else {
          cur = { y0: y, y1: y };
          bands.push(cur);
        }
      }
    }

    const pad = Math.max(1, Math.round(barH * 0.12));
    const margin = Math.max(1, Math.round(barH * 0.05));
    let rows = [];
    for (const band of bands) {
      if (band.y1 - band.y0 + 1 < 2) continue;
      const right = countBox(mask, W, sx0, sx1, band.y0, band.y1);
      const hasEye = right.blue >= minIcon;
      const hasButton = right.green >= bigButton;
      if (!hasEye && !hasButton) continue;
      const box = { y0: Math.max(yStart, band.y0 - pad), y1: Math.min(yEnd, band.y1 + pad) };
      if (hasButton) {
        // Edit page: the coloured dot is the first mark left of the label.
        box.x0 = bar.x0;
        box.x1 = bar.x0 + Math.round(w * 0.3);
        const dot = firstInkRun(img, box);
        if (dot) {
          box.x0 = dot.x0;
          box.x1 = dot.x1;
        }
      } else {
        // View page: the ✓ / ✗ / • icon right before the eye icon.
        box.x0 = sx0;
        box.x1 = Math.max(sx0, blueMinX(mask, W, sx0, sx1, band) - margin);
      }
      const ink = inkStatus(img, box);
      rows.push({ y0: band.y0, y1: band.y1, kind: hasButton ? 'edit' : 'view', status: ink.status, box: ink.box || box });
    }

    // Rows are evenly spaced; anything after a big gap is not part of this card.
    if (rows.length >= 3) {
      const gaps = [];
      for (let i = 1; i < rows.length; i++) gaps.push(rows[i].y0 - rows[i - 1].y0);
      const pitch = median(gaps);
      for (let i = 1; i < rows.length; i++) {
        if (rows[i].y0 - rows[i - 1].y0 > 1.9 * pitch) {
          rows = rows.slice(0, i);
          break;
        }
      }
    }
    return rows;
  }

  function blueMinX(mask, W, x0, x1, band) {
    let min = x1;
    for (let y = band.y0; y <= band.y1; y++) {
      const row = y * W;
      for (let x = x0; x < min; x++) {
        if (mask[row + x] === C.BLUE) {
          min = x;
          break;
        }
      }
    }
    return min;
  }

  // "Ink": anything clearly darker or more colourful than the white card.
  function inkWeight(r, g, b) {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const dark = 255 - (r + g + b) / 3;
    const chroma = max - min;
    return dark >= 28 || chroma >= 40 ? dark + chroma : 0;
  }

  function firstInkRun(img, box) {
    const { width: W, data } = img;
    let start = -1;
    let end = -1;
    for (let x = box.x0; x <= box.x1; x++) {
      let ink = false;
      for (let y = box.y0; y <= box.y1 && !ink; y++) {
        const p = (y * W + x) * 4;
        ink = inkWeight(data[p], data[p + 1], data[p + 2]) > 0;
      }
      if (ink) {
        if (start < 0) start = x;
        end = x;
      } else if (start >= 0 && x - end > 1) break;
    }
    return start < 0 ? null : { x0: start, x1: end };
  }

  // Status from the average colour of the icon, weighted by how much ink each
  // pixel carries. Survives JPEG compression, which washes out thin icons.
  // Returns { status, box } (box: where the ink is).
  function inkStatus(img, box) {
    const { width: W, data } = img;
    let sw = 0;
    let sr = 0;
    let sg = 0;
    let sb = 0;
    let n = 0;
    const ink = { x0: Infinity, x1: -1, y0: Infinity, y1: -1 };
    for (let y = box.y0; y <= box.y1; y++) {
      for (let x = box.x0; x <= box.x1; x++) {
        const p = (y * W + x) * 4;
        const wt = inkWeight(data[p], data[p + 1], data[p + 2]);
        if (!wt) continue;
        sw += wt;
        sr += wt * data[p];
        sg += wt * data[p + 1];
        sb += wt * data[p + 2];
        n++;
        if (x < ink.x0) ink.x0 = x;
        if (x > ink.x1) ink.x1 = x;
        if (y < ink.y0) ink.y0 = y;
        if (y > ink.y1) ink.y1 = y;
      }
    }
    if (n < 2) return { status: 'unknown', box: null };
    return { status: inkColor(sr / sw, sg / sw, sb / sw), box: ink };
  }

  function inkColor(r, g, b) {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    const s = max ? d / max : 0;
    if (s < 0.1) return 'na';
    let h;
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
    if (h < 0) h += 360;
    if (h >= 80 && h <= 180 && s >= 0.1) return 'green';
    if ((h <= 25 || h >= 320) && s >= 0.1) return 'red';
    if (h >= 35 && h <= 65 && s >= 0.2) return 'yellow';
    return 'na';
  }

  // ------------------------------------------------------------- main

  /**
   * @param {{width:number,height:number,data:Uint8ClampedArray}} img  RGBA pixels (ImageData)
   * @returns {{width, height, mode, naDoubtful, sections:[{box, rows:[{y0,y1,status,kind,icon}]}], warnings:string[]}}
   *   box: the section's header bar; icon: where the row's status was read (for drawing the preview)
   *   naDoubtful: so many rows read as NA that the screenshot is probably too compressed
   */
  function analyze(img) {
    const W = img.width;
    const H = img.height;
    const mask = classifyImage(img);
    const bars = findBars(mask, W, H);
    const warnings = [];

    let sections = bars.map((bar) => {
      const below = bars.filter((o) => o !== bar && o.y0 > bar.y1 && xOverlap(o, bar) >= 0.5 * Math.min(o.x1 - o.x0, bar.x1 - bar.x0));
      const yEnd = below.length ? Math.min(...below.map((o) => o.y0)) - 1 : H - 1;
      return { box: { x0: bar.x0, y0: bar.y0, x1: bar.x1, y1: bar.y1 }, rows: sectionRows(img, mask, bar, yEnd) };
    });
    sections = sections.filter((s) => s.rows.length > 0);

    // Section cards share one width; drop odd ones out (e.g. a blue table header).
    if (sections.length > 2) {
      const width = median(sections.map((s) => s.box.x1 - s.box.x0));
      sections = sections.filter((s) => Math.abs(s.box.x1 - s.box.x0 - width) <= 0.15 * width);
    }

    // Reading order: top to bottom by grid row, then left to right.
    const barH = median(sections.map((s) => s.box.y1 - s.box.y0 + 1)) || 1;
    sections.sort((a, b) => a.box.y0 - b.box.y0);
    let line = -1;
    let lineY = -Infinity;
    for (const s of sections) {
      if (s.box.y0 - lineY > barH * 0.7) {
        line++;
        lineY = s.box.y0;
      }
      s.line = line;
    }
    sections.sort((a, b) => a.line - b.line || a.box.x0 - b.box.x0);

    const kinds = sections.flatMap((s) => s.rows.map((r) => r.kind));
    const edit = kinds.filter((k) => k === 'edit').length;
    const mode = !kinds.length ? 'none' : edit === 0 ? 'view' : edit === kinds.length ? 'edit' : 'mixed';

    if (!sections.length) {
      warnings.push(
        'No audit sections found. Use a screenshot of the View Server Audit page that shows the blue section headers and the ✓ / ✗ icons.'
      );
    }
    const all = sections.flatMap((s) => s.rows);
    const unknown = all.filter((r) => r.status === 'unknown').length;
    if (unknown) warnings.push(unknown + ' row(s) have no readable status; they are left alone.');
    const na = all.filter((r) => r.status === 'na').length;
    // Washed-out ✓ icons read as grey, so too many NA rows mean the NA reading can't be trusted.
    const naDoubtful = all.length >= 6 && na > all.length * 0.3;
    if (naDoubtful) {
      warnings.push(
        'Many rows read as NA (grey), so they are not set to NA. If the screenshot shows ✓ there, it is too compressed or too small: use a PNG screenshot (Firefox: right-click → Take Screenshot) at 50–100% zoom.'
      );
    }

    return {
      width: W,
      height: H,
      mode,
      naDoubtful,
      sections: sections.map((s) => ({
        box: s.box,
        rows: s.rows.map(({ y0, y1, status, kind, box }) => ({ y0, y1, status, kind, icon: { x0: box.x0, x1: box.x1, y0: box.y0, y1: box.y1 } })),
      })),
      warnings,
    };
  }

  // ------------------------------------------------------------- matching

  /**
   * Pair the screenshot's sections and rows with the sections and items on the
   * audit page, by position (both are in reading order).
   *
   * @param analysis      result of analyze()
   * @param pageSections  [{ name, items: [{ label, state }] }]  (state: current colour on the page)
   * @param opts          { skipDone: boolean  leave items alone that already have that colour on the page,
   *                        markNA: boolean    also mark grey (NA) rows as NA }
   * @returns {{ sections: [{ name, refRows, mismatch, items: [{ label, state, ref, target, mark, note }] }], warnings: string[], toMark: number }}
   *   target: what the item would be set to: 'green' (first option), 'na' (the NA option) or null
   */
  function matchToPage(analysis, pageSections, opts) {
    const o = Object.assign({ skipDone: true, markNA: true }, opts);
    const ref = (analysis && analysis.sections) || [];
    const warnings = [];
    if (ref.length !== pageSections.length) {
      warnings.push(
        'The screenshot has ' + ref.length + ' section(s), this page has ' + pageSections.length + '. Sections are paired in order; check the list.'
      );
    }
    let toMark = 0;
    const sections = pageSections.map((ps, si) => {
      const rs = ref[si];
      const refRows = rs ? rs.rows.length : 0;
      const mismatch = !!rs && refRows !== ps.items.length;
      if (!rs) warnings.push('"' + ps.name + '": not in the screenshot, nothing will be changed.');
      else if (mismatch) {
        warnings.push(
          '"' + ps.name + '": the screenshot shows ' + refRows + ' row(s), the page has ' + ps.items.length + '. Nothing ticked there; tick items yourself if they are right.'
        );
      }
      const items = ps.items.map((it, i) => {
        const r = rs && rs.rows[i] ? rs.rows[i].status : 'missing';
        const target = r === 'green' ? 'green' : r === 'na' && o.markNA && !analysis.naDoubtful ? 'na' : null;
        let mark = !!target && !mismatch;
        let note = '';
        if (mark && o.skipDone && it.state === (target === 'na' ? 'grey' : 'green')) {
          mark = false;
          note = target === 'na' ? 'already NA' : 'already active';
        }
        if (mark) toMark++;
        return { label: it.label, state: it.state || 'unknown', ref: r, target, mark, note };
      });
      return { name: ps.name, refRows, mismatch, items };
    });
    return { sections, warnings, toMark };
  }

  const api = { C, classify, classifyImage, findBars, analyze, matchToPage };
  root.AuditAnalyzer = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
