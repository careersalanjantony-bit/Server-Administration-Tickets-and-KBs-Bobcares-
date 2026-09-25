/*
 * Quiz Autopilot - answer-key parsing and fuzzy matching.
 *
 * Pure functions only (no DOM access) so the same file is shared by the
 * content script, the popup, and the Node unit tests.
 */
(function (root) {
  'use strict';

  // Words that carry no meaning for matching. "not", "no", "only", "all",
  // "none" and "both" are deliberately NOT here - they flip meanings.
  const STOPWORDS = new Set((
    'a an the of to in on for is are was were be been being with by it its this that these those as at ' +
    'from into then than there their we our you your me my they them do does did can could should would ' +
    'will shall may might must has have had about which what when where who whom whose how why i'
  ).split(/\s+/));

  // Extra filler that only shows up in question stems.
  const QUESTION_STOPWORDS = new Set((
    'select choose pick following statement correct option answer true false question below given ' +
    'regarding identify mark'
  ).split(/\s+/));

  // ---------------------------------------------------------------- text utils

  function clean(s) {
    return String(s == null ? '' : s)
      .replace(/\*\*|__/g, '')
      .replace(/`/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^["'\u201c\u2018](.*)["'\u201d\u2019]$/, '$1') // only quotes wrapping the whole text
      .trim();
  }

  function norm(s) {
    return clean(s)
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[\u2018\u2019\u00b4`]/g, "'")
      .replace(/[\u201c\u201d]/g, '"')
      .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015]/g, '-')
      .replace(/^\s*(?:q(?:uestion)?\s*)?\d+\s*[.):-]\s+/, '') // leading "4. " numbering
      .replace(/\s+/g, ' ')
      .trim();
  }

  function stem(t) {
    if (/^\d+$/.test(t)) return t;
    if (t.length > 4 && t.endsWith('ies')) return t.slice(0, -3) + 'y';
    if (t.length > 5 && t.endsWith('ing')) return t.slice(0, -3);
    if (t.length > 4 && t.endsWith('ed')) return t.slice(0, -2);
    if (t.length > 3 && t.endsWith('s') && !/(ss|us|is)$/.test(t)) return t.slice(0, -1);
    return t;
  }

  function tokens(s, extraStop) {
    const raw = norm(s).match(/[a-z0-9]+/g) || [];
    const out = [];
    for (const t of raw) {
      if (t.length < 2 && !/^\d$/.test(t)) continue;
      if (STOPWORDS.has(t) || (extraStop && extraStop.has(t))) continue;
      const st = stem(t);
      if (extraStop && extraStop.has(st)) continue;
      if (!out.includes(st)) out.push(st);
    }
    return out;
  }

  function tokenMatch(a, b) {
    if (a === b) return true;
    if (/^\d+$/.test(a) || /^\d+$/.test(b)) return false; // numbers must be exact
    const m = Math.min(a.length, b.length);
    if (m >= 4 && (a.startsWith(b) || b.startsWith(a))) return true;
    if (m >= 6) {
      let i = 0;
      while (i < m && a[i] === b[i]) i++;
      if (i >= 6) return true;
    }
    return false;
  }

  // Fraction of tokens in A that have a match somewhere in B.
  function coverage(A, B) {
    if (!A.length) return 0;
    let hit = 0;
    for (const a of A) if (B.some((b) => tokenMatch(a, b))) hit++;
    return hit / A.length;
  }

  function trigramSim(a, b) {
    const grams = (s) => {
      const g = new Set();
      const p = ' ' + s.replace(/[^a-z0-9]+/g, ' ').trim() + ' ';
      for (let i = 0; i < p.length - 2; i++) g.add(p.slice(i, i + 3));
      return g;
    };
    const A = grams(a);
    const B = grams(b);
    if (!A.size || !B.size) return 0;
    let inter = 0;
    for (const g of A) if (B.has(g)) inter++;
    return (2 * inter) / (A.size + B.size);
  }

  // "All of the above", "All listed steps", "None of the above", "Both of the above", ...
  function genericKind(text) {
    const n = norm(text).replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!n || n.split(' ').length > 8) return null;
    if (/^none\b/.test(n)) return 'none';
    if (/^both (of )?(the )?(above|these|options?|statements?|answers?)\b/.test(n) || /^both [a-d1-4] (and )?[a-d1-4]$/.test(n)) {
      return 'both';
    }
    if (
      /^(all|every)\b/.test(n) &&
      (n === 'all' || /\b(above|these|statements?|listed|steps?|of them|correct|options?|mentioned|given|answers?)\b/.test(n))
    ) {
      return 'all';
    }
    return null;
  }

  // One key answer can span several lines (bullets, numbered list, wrapped text).
  function answerLines(answer) {
    return String(answer).split('\n').map(clean).filter(Boolean);
  }

  // "A OR B" in an answer key means either wording is acceptable.
  function answerAlternatives(answer) {
    return String(answer).split(/\s+OR\s+/).map(clean).filter(Boolean);
  }

  // Bullets / lines, "A + B + C" and "A; B" describe several separate statements.
  function answerParts(answer) {
    return String(answer).split(/\s\+\s|;\s+|\s&\s|\s+AND\s+|\n/).map(clean).filter(Boolean);
  }

  // ---------------------------------------------------------------- scoring

  function textScore(keyText, optText) {
    const k = norm(keyText);
    const o = norm(optText);
    if (!k || !o) return 0;
    if (k === o) return 1;
    const kt = tokens(k);
    const ot = tokens(o);
    const tri = trigramSim(k, o);
    if (!kt.length || !ot.length) return tri * 0.8;
    const cov = coverage(kt, ot);
    const rev = coverage(ot, kt);
    const dice = (cov * kt.length + rev * ot.length) / (kt.length + ot.length);
    let s = 0.5 * cov + 0.3 * dice + 0.2 * tri;
    if (Math.min(k.length, o.length) >= 6 && (o.includes(k) || k.includes(o))) s = Math.max(s, 0.9);
    return Math.min(1, s);
  }

  /** How well a single on-page option matches the key's answer (0..1). */
  function answerScore(keyAnswer, optionText) {
    const kg = genericKind(keyAnswer);
    const og = genericKind(optionText);
    if (kg) return kg === og ? 1 : 0.05;
    let best = textScore(keyAnswer, optionText);
    const alts = new Set(answerAlternatives(keyAnswer).concat(answerLines(keyAnswer)));
    if (alts.size > 1) {
      for (const alt of alts) best = Math.max(best, 0.95 * textScore(alt, optionText));
    }
    return best;
  }

  /** How well the key's question matches the question on the page (0..1). */
  function questionScore(keyQuestion, pageQuestion) {
    const k = norm(keyQuestion);
    const p = norm(pageQuestion);
    if (!k || !p) return 0;
    if (k === p) return 1;
    const kt = tokens(k, QUESTION_STOPWORDS);
    const pt = tokens(p, QUESTION_STOPWORDS);
    const tri = trigramSim(k, p);
    if (!kt.length || !pt.length) return tri * 0.8;
    const cov = coverage(kt, pt);
    const rev = coverage(pt, kt);
    const dice = (cov * kt.length + rev * pt.length) / (kt.length + pt.length);
    let s = 0.6 * cov + 0.25 * dice + 0.15 * tri;
    // Very short key questions match too many things; damp them.
    s *= Math.min(1, 0.6 + 0.15 * kt.length);
    if (Math.min(k.length, p.length) >= 12 && (p.includes(k) || k.includes(p))) s = Math.max(s, 0.92);
    return Math.min(1, s);
  }

  // Question score for a key entry, also trying the page's description and,
  // when the key copied extra lines (e.g. the options), the page's options.
  function entryQuestionScore(entry, q, optionTexts) {
    let qs = questionScore(entry.q, q.text);
    if (q.extraText) qs = Math.max(qs, 0.95 * questionScore(entry.q, q.text + ' ' + q.extraText));
    if (entry.qx) {
      const ctx = [q.text, q.extraText || ''].concat(optionTexts || []).join(' ');
      qs = Math.max(qs, 0.9 * questionScore(entry.q + ' ' + entry.qx, ctx));
    }
    return qs;
  }

  // ---------------------------------------------------------------- solving

  const noMatch = (reason) => ({
    picks: [],
    rowPicks: [],
    fills: [],
    confidence: 'none',
    entry: null,
    qScore: 0,
    aScore: 0,
    reason,
    ranked: [],
  });

  /**
   * Decide how to answer one question.
   *
   * @param {object} q  { kind: 'choice'|'select'|'text', text, extraText?,
   *                      options: string[], multi: boolean,      (choice)
   *                      rows: [{label, options: string[]}],     (select: matching / ordering drop-downs)
   *                      fieldCount: number }                    (text: typed answers)
   * @param {Array} entries  parsed answer key [{ q, a, qx? }]
   * @returns {{ picks:number[], rowPicks:number[], fills:string[], confidence:'high'|'low'|'none',
   *            entry, qScore, aScore, reason, ranked }}
   */
  function solve(q, entries) {
    if (!entries || !entries.length) return noMatch('The answer key is empty.');
    if (q.kind === 'select') return solveSelect(q, entries);
    if (q.kind === 'text') return solveText(q, entries);

    const options = q.options || [];
    if (!options.length) return noMatch('No answer options found for this question.');

    const ranked = entries.map((entry) => {
      const qs = entryQuestionScore(entry, q, options);
      const scores = options.map((o) => answerScore(entry.a, o));
      let bestIdx = 0;
      for (let i = 1; i < scores.length; i++) if (scores[i] > scores[bestIdx]) bestIdx = i;
      const best = scores[bestIdx];
      const second = scores.reduce((m, s, i) => (i === bestIdx ? m : Math.max(m, s)), 0);
      const generic = !!genericKind(entry.a);
      const combined = 0.65 * qs + 0.35 * best * (generic ? 0.6 : 1);
      return { entry, qs, scores, bestIdx, best, second, generic, combined };
    });
    ranked.sort((a, b) => b.combined - a.combined);

    const w = ranked[0];
    const base = { entry: w.entry, qScore: w.qs, aScore: w.best, ranked: ranked.slice(0, 5), rowPicks: [], fills: [] };

    if (w.qs < 0.25 && !(w.best >= 0.85 && !w.generic)) {
      return Object.assign(base, { picks: [], confidence: 'none', reason: 'No answer-key question looks like this one.' });
    }

    return q.multi ? solveMulti(q, w, ranked, base) : solveSingle(q, w, ranked, base);
  }

  function solveSingle(q, w, ranked, base) {
    const options = q.options;
    let pick = w.bestIdx;
    const best = w.best;
    const reasons = [];

    // The key lists several statements (bullets, "A + B", "A; B"). If they
    // match different options and there's an "All/Both of the above" option,
    // that's the answer - unless one option contains the whole answer.
    const parts = answerParts(w.entry.a);
    const allIdx = options.findIndex((o) => ['all', 'both'].includes(genericKind(o)));
    let inferred = false;
    let inferredSure = false;
    if (allIdx >= 0 && parts.length >= 2 && !w.generic) {
      const whole = Math.max(...options.map((o, i) => (i === allIdx ? 0 : textScore(w.entry.a, o))));
      if (whole < 0.8) {
        const thr = best < 0.7 ? 0.42 : 0.6;
        const matched = new Set();
        let strong = 0;
        for (const part of parts) {
          const sc = options.map((o, i) => (genericKind(o) ? 0 : textScore(part, o)));
          const bi = sc.indexOf(Math.max(...sc));
          if (sc[bi] >= thr && !matched.has(bi)) {
            matched.add(bi);
            if (sc[bi] >= 0.6) strong++;
          }
        }
        if (matched.size >= 2) {
          pick = allIdx;
          inferred = true;
          const statements = options.filter((o) => !genericKind(o)).length;
          inferredSure = w.qs >= 0.5 && strong >= 2 && matched.size === statements;
          reasons.push('Your key lists several statements, so "' + clean(options[allIdx]) + '" was chosen.');
        }
      }
    }

    if (best < 0.35 && !inferred) {
      return Object.assign(base, {
        picks: [],
        confidence: 'none',
        reason: 'Question matched, but none of the options looks like the key answer "' + clean(w.entry.a) + '".',
      });
    }

    let confident = inferred ? inferredSure : true;
    if (!inferred) {
      if (!((w.qs >= 0.5 && best >= 0.5) || (w.qs >= 0.3 && best >= 0.8 && !w.generic))) {
        confident = false;
        reasons.push('Weak match.');
      }
      if (confident && !(best - w.second >= 0.12 || (best >= 0.95 && w.second < 0.9))) {
        confident = false;
        reasons.push('Two options look almost equally right.');
      }
    }
    if (confident) {
      const rival = ranked.find((r) => r !== w && r.bestIdx !== pick && r.best >= 0.35);
      if (rival && rival.combined >= w.combined - 0.06) {
        confident = false;
        reasons.push('Another key entry ("' + clean(rival.entry.q) + '") points to a different option.');
      }
    }
    if (confident && !inferred) {
      // A second key entry for this same question that accepts two of the options ("A OR B").
      const shaky = ranked.find((r) => r !== w && r.qs >= 0.4 && r.qs >= w.qs - 0.45 && r.second >= 0.5 && r.best - r.second < 0.12);
      if (shaky) {
        confident = false;
        reasons.push('Your key accepts more than one of these options ("' + clean(shaky.entry.a) + '").');
      }
    }

    return Object.assign(base, {
      picks: [pick],
      confidence: confident ? 'high' : 'low',
      reason: reasons.join(' '),
    });
  }

  function solveMulti(q, w, ranked, base) {
    const options = q.options;
    const picks = new Set();
    let allGood = true;

    if (w.generic && genericKind(w.entry.a) === 'all') {
      options.forEach((o, i) => {
        if (genericKind(o) !== 'none') picks.add(i);
      });
    } else {
      // Each statement in the key ticks the one option it matches best. Wrong
      // options often differ by a word or two, so a close runner-up means "check".
      // "A OR B" on a multiple-answer question means both are correct.
      const parts = answerParts(w.entry.a).reduce((acc, p) => acc.concat(answerAlternatives(p)), []);
      for (const part of parts.length > 1 ? parts : [w.entry.a]) {
        const sc = options.map((o) => textScore(part, o));
        const bi = sc.indexOf(Math.max(...sc));
        const second = sc.reduce((m, s, i) => (i === bi || picks.has(i) ? m : Math.max(m, s)), 0);
        if (sc[bi] >= 0.45) picks.add(bi);
        if (sc[bi] < 0.55 || !(sc[bi] - second >= 0.08 || sc[bi] >= 0.97)) allGood = false;
      }
    }

    const list = [...picks].sort((a, b) => a - b);
    if (!list.length) {
      return Object.assign(base, { picks: [], confidence: 'none', reason: 'No option matches the key answer "' + clean(w.entry.a) + '".' });
    }
    const confident = allGood && w.qs >= 0.5;
    return Object.assign(base, {
      picks: list,
      confidence: confident ? 'high' : 'low',
      reason: confident ? '' : 'Multiple-answer question - please double-check the ticked options.',
    });
  }

  // Pairs a matching/ordering answer can describe. "1. Priority Chats" means
  // position 1 <-> "Priority Chats"; "Apache -> web server" is an explicit pair.
  function matchingPairs(answer) {
    const pairs = [];
    answerLines(answer).forEach((line, i) => {
      const m = line.match(/^\(?(\d{1,2}|[a-z])\s*[.):]\s+(.+)$/i);
      const pos = m ? m[1] : String(i + 1);
      const body = m ? m[2] : line;
      pairs.push({ left: pos, right: body }, { left: body, right: pos });
      const sp = body.split(/\s*(?:\u2192|->|=>|\u21d2|:)\s*/).filter(Boolean);
      if (sp.length === 2) pairs.push({ left: sp[0], right: sp[1] }, { left: sp[1], right: sp[0] });
    });
    return pairs;
  }

  const ORDINALS = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

  // "1", "1st", "First", "Priority 1", "Position 2" -> the number; anything else -> null.
  function positionOf(s) {
    const n = clean(s).toLowerCase().replace(/[.):\s]+$/, '');
    const pre = '(?:(?:priority|order|position|rank|step|level|no\\.?|number|#)\\s*)?';
    const post = '(?:\\s*(?:priority|place|position))?';
    let m = n.match(new RegExp('^' + pre + '(\\d{1,2})(?:st|nd|rd|th)?' + post + '$'));
    if (m) return +m[1];
    m = n.match(new RegExp('^' + pre + '([a-z]+)' + post + '$'));
    return m && ORDINALS[m[1]] ? ORDINALS[m[1]] : null;
  }

  // Positions and single letters must match exactly; text is compared fuzzily.
  function sideScore(a, b) {
    const pa = positionOf(a);
    const pb = positionOf(b);
    if (pa != null || pb != null) return pa === pb ? 1 : 0;
    const sa = clean(a).replace(/[.):\s]+$/, '');
    const sb = clean(b).replace(/[.):\s]+$/, '');
    if (/^[a-z]$/i.test(sa) || /^[a-z]$/i.test(sb)) return sa.toLowerCase() === sb.toLowerCase() ? 1 : 0;
    return textScore(sa, sb);
  }

  // Matching / ordering questions: one drop-down per row.
  function solveSelect(q, entries) {
    const rows = q.rows || [];
    if (!rows.length) return noMatch('No drop-downs found for this question.');
    const allOptions = rows.reduce((acc, r) => acc.concat(r.options), []);
    const rowLabels = rows.map((r) => r.label);

    const ranked = entries.map((entry) => {
      const qs = entryQuestionScore(entry, q, rowLabels.concat(allOptions));
      const pairs = matchingPairs(entry.a);
      const rowRes = rows.map((row) => {
        const sc = row.options.map((opt) => pairs.reduce((m, p) => Math.max(m, Math.min(sideScore(p.left, row.label), sideScore(p.right, opt))), 0));
        let pick = 0;
        for (let i = 1; i < sc.length; i++) if (sc[i] > sc[pick]) pick = i;
        const second = sc.reduce((m, s, i) => (i === pick ? m : Math.max(m, s)), 0);
        return { pick, score: sc.length ? sc[pick] : 0, second };
      });
      const avg = rowRes.reduce((s, r) => s + r.score, 0) / rowRes.length;
      return { entry, qs, rowRes, avg, combined: 0.65 * qs + 0.35 * avg };
    });
    ranked.sort((a, b) => b.combined - a.combined);
    const w = ranked[0];
    const base = { entry: w.entry, qScore: w.qs, aScore: w.avg, ranked: ranked.slice(0, 5), picks: [], fills: [] };

    if (w.qs < 0.3 || w.avg < 0.3) {
      return Object.assign(base, {
        rowPicks: [],
        confidence: 'none',
        reason: w.qs < 0.3 ? 'No answer-key question looks like this one.' : 'Could not work out the drop-down choices from your key.',
      });
    }
    const confident = w.qs >= 0.5 && w.rowRes.every((r) => r.score >= 0.75 && r.score - r.second >= 0.15);
    return Object.assign(base, {
      rowPicks: w.rowRes.map((r) => (r.score >= 0.4 ? r.pick : -1)),
      confidence: confident ? 'high' : 'low',
      reason: confident ? '' : 'Drop-down question - please check the selections.',
    });
  }

  // Typed answers (fill in the blanks / open question): fill in, always ask to check.
  function solveText(q, entries) {
    const ranked = entries
      .map((entry) => ({ entry, qs: entryQuestionScore(entry, q, []) }))
      .sort((a, b) => b.qs - a.qs);
    const w = ranked[0];
    if (w.qs < 0.45) return noMatch('No answer-key question looks like this one.');
    const lines = answerLines(w.entry.a);
    const n = Math.max(1, q.fieldCount || 1);
    const fills = n > 1 && lines.length >= n ? lines.slice(0, n) : [lines.join('\n')];
    return {
      picks: [],
      rowPicks: [],
      fills,
      confidence: 'low',
      entry: w.entry,
      qScore: w.qs,
      aScore: 0,
      ranked: ranked.slice(0, 5),
      reason: 'Typed answer filled in from your key - please check it.',
    };
  }

  // ---------------------------------------------------------------- key parsing

  // Split a markdown table row on "|" but not on "\|" or on "|" inside `code`.
  function splitCells(line, codeAware) {
    const cells = [];
    let cur = '';
    let inCode = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '\\' && line[i + 1] === '|') {
        cur += '|';
        i++;
        continue;
      }
      if (codeAware && ch === '`') inCode = !inCode;
      if (ch === '|' && !inCode) {
        cells.push(cur);
        cur = '';
        continue;
      }
      cur += ch;
    }
    cells.push(cur);
    if (codeAware && inCode) return splitCells(line, false); // unbalanced backticks
    return cells;
  }

  const SEPARATORS = [' => ', ' ==> ', ' -> ', ' :: ', '\t'];
  // Check marks / arrows people put in front of answers: (check marks, arrows, pointing-hand emoji)
  const MARKS = /^(?:[\u2705\u2714\u2611\u2713\u2192\u27a1\u2b50\u{1F449}\u{1F7E2}]\ufe0f?\s*)+/u;
  const TRAILING_MARK = /\s*(?:[\u2705\u2714\u2611\u2713]\ufe0f?|\((?:correct|right|answer)\))\s*$/iu;
  const BULLET = /^[-*+\u2022\u00b7\u25cf\u25aa\u25e6]\s+/;
  const NUM = /^\(?(\d{1,3})\s*[.):]\s+(.+)$/; // "12. text", "12) text", "(12) text"
  const LETTER = /^\(?([a-h])\s*[.)]\s+(.+)$/i; // "a) option", "B. option"
  const QMARK = /^(?:q|ques|question)\s*(\d{1,3})?\s*[:.)\-]\s*(.+)$/i; // "Q: ..", "Q12. ..", "Question 12: .."
  const AMARK = /^(?:(?:ans(?:wer)?s?|correct(?:\s+(?:answer|option|choice))?|right\s+answer|solution)\s*[:=\-\u2013\u2014]|a\s*[:=])\s*(.*)$/i;
  const QUESTION_WORD = /^(what|which|how|why|when|where|who|whom|select|choose|match|according|if|you|is|are|do|does|can|should|in|for)\b/i;

  /**
   * Parse a pasted answer key. Works with any mix of:
   *   1. Question                        numbered (or "Q:", "Question 3:") question,
   *   Answer: text                       then "Answer:" / "Ans:" / "A:" / "Correct answer:" (bold, check-mark ignored)
   *   Answer:                            the answer may start on the next line and span several lines,
   *   * bullet  /  1. numbered item      bullets or a numbered list (kept as separate answer lines)
   *   | 1 | Question | Answer |          markdown table (# column optional)
   *   Question | Answer                  or  Question => Answer  (->, ::, TAB)
   *   Question?  /  Answer               a line ending in "?" and its answer on the next line
   *   1. Question / - option / - check-mark option   options with the right one marked check-mark or "(correct)"
   *   JSON: [{"q": "...", "a": "..."}]  or  {"question": "answer"}
   * Headings, intro text and "answers to memorize" lists without questions are ignored.
   */
  function parseKey(text) {
    const entries = [];
    const seen = new Set();

    const cleanAnswerLine = (l) => clean(String(l).replace(MARKS, '').replace(BULLET, '')).replace(MARKS, '').replace(TRAILING_MARK, '').trim();

    const push = (q, a, qx) => {
      q = clean(q).replace(/^(?:q(?:ues(?:tion)?)?\s*\d*\s*[:.)]|\d+\s*[.)])\s*/i, '');
      let lines = (Array.isArray(a) ? a : [a]).map(cleanAnswerLine).filter(Boolean);
      // Drop lead-ins such as "Select ALL:" that only introduce a list.
      if (lines.length > 1) lines = lines.filter((l, i) => !(i < lines.length - 1 && /:$/.test(l) && l.split(/\s+/).length <= 6));
      if (!q || !lines.length) return;
      const ans = lines.join('\n');
      const id = norm(q) + '\u0000' + norm(ans);
      if (seen.has(id)) return;
      seen.add(id);
      const entry = { q, a: ans };
      const extra = clean((qx || []).join(' '));
      if (extra) entry.qx = extra;
      entries.push(entry);
    };

    const isHeader = (p) =>
      /^(#|no\.?|question)$/i.test(p[0]) || (/question/i.test(p[0]) && p[0].length < 20 && /answer/i.test(p[1]));
    const isRule = (c) => /^:?-{2,}:?$/.test(c);

    // "question | answer" or "question => answer" on one line; null if the line is not a pair.
    const pairOf = (s, allowPipes) => {
      if (allowPipes && s.includes('|')) {
        let cells = splitCells(s, true).map(clean).filter((c) => c !== '');
        if (cells.length > 2 && /^#?\d+[.)]?$/.test(cells[0])) cells = cells.slice(1); // "# / 1" column
        if (cells.length >= 2) return cells;
      }
      const sep = SEPARATORS.find((x) => s.includes(x));
      if (sep) {
        const i = s.indexOf(sep);
        return [s.slice(0, i), s.slice(i + sep.length)];
      }
      return null;
    };

    // Section titles such as "Additional Questions You Shared Later".
    const isHeadingLike = (s) =>
      !/[.?!;,]$/.test(s) && s.split(/\s+/).length <= 10 && /\b(questions?|answers?|quiz|section|additional|bonus|memori[sz]e)\b/i.test(s);

    const t = String(text || '').replace(/\r\n?/g, '\n').trim();
    if (!t) return entries;

    if (/^[[{]/.test(t)) {
      try {
        const data = JSON.parse(t);
        const arr = Array.isArray(data) ? data : Object.keys(data).map((k) => ({ q: k, a: data[k] }));
        for (const it of arr) {
          if (!it) continue;
          push(it.q != null ? it.q : it.question, it.a != null ? it.a : it.answer);
        }
        return entries;
      } catch (e) {
        /* not JSON - fall through to line parsing */
      }
    }

    const lines = t.split('\n').map((l) => l.trim());
    const plainOf = (l) => l.replace(/\*\*|__/g, '').trim();

    // Is there an "Answer:" line before the next question starts?
    const answerMarkerAhead = (from) => {
      for (let j = from + 1; j < lines.length && j < from + 25; j++) {
        const p = plainOf(lines[j]);
        if (!p) continue;
        if (AMARK.test(p)) return true;
        if (NUM.test(p) || QMARK.test(p) || /^#{1,6}\s/.test(p) || p.startsWith('|')) return false;
      }
      return false;
    };

    let cur = null; // { q, qx:[], a:[], num, loose, answering, lastItem, optItem }
    const finish = () => {
      if (cur && cur.a.length) push(cur.q, cur.a, cur.qx);
      cur = null;
    };
    const startQ = (qText, num, loose) => {
      finish();
      // Inline answer: "Which port? Answer: 22"
      const ia = qText.match(/^(.*?\S)\s+(?:answer|ans)\s*[:=]\s*(.+)$/i);
      if (ia) return push(ia[1], [ia[2]]);
      const pair = pairOf(qText, false);
      if (pair) return push(pair[0], [pair[1]]);
      cur = { q: qText, qx: [], a: [], num, loose, answering: false, lastItem: null, optItem: null };
    };
    const addAnswer = (s) => {
      const m = s.match(NUM);
      cur.lastItem = m ? +m[1] : cur.lastItem;
      cur.a.push(s);
    };
    // Inside an answer, is "n. text" the next item of the answer's own list?
    const isListItem = (n, body) => {
      if (cur.lastItem != null && n === cur.lastItem + 1) {
        return !(cur.num != null && n === cur.num + 1 && (/\?$/.test(body) || QUESTION_WORD.test(body)));
      }
      const last = cur.a[cur.a.length - 1];
      return cur.lastItem == null && n === 1 && (!cur.a.length || /:$/.test(last));
    };

    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      if (!line || /^```/.test(line)) continue;
      if (/^([-*_])\1{2,}$/.test(line)) {
        finish();
        continue;
      }
      const plain = plainOf(line);
      if (!plain) continue;
      let m;

      if (/^#{1,6}\s/.test(plain)) {
        finish();
        continue;
      }

      if (line.startsWith('|')) {
        finish();
        const pair = pairOf(line, true);
        if (pair && !isHeader(pair) && !pair.every(isRule)) push(pair[0], [pair[1]]);
        continue;
      }

      if (cur && (m = plain.match(AMARK))) {
        cur.answering = true;
        const rest = m[1].replace(MARKS, '').trim();
        if (rest) addAnswer(rest);
        continue;
      }

      if ((m = plain.match(QMARK))) {
        startQ(m[2], m[1] ? +m[1] : null, false);
        continue;
      }

      if ((m = plain.match(NUM))) {
        const n = +m[1];
        if (cur && cur.answering && isListItem(n, m[2])) {
          addAnswer(plain);
          continue;
        }
        if (cur && !cur.answering) {
          const isOption = cur.num != null ? n <= cur.num : n === 1 ? cur.optItem == null : n === cur.optItem + 1;
          if (isOption) {
            // A numbered option list under the question; "check-mark" marks the answer.
            cur.optItem = n;
            if (MARKS.test(m[2]) || TRAILING_MARK.test(m[2])) cur.a.push(m[2]);
            else cur.qx.push(m[2]);
            continue;
          }
        }
        startQ(m[2], n, false);
        continue;
      }

      if (cur && !cur.answering && (m = plain.match(LETTER))) {
        // A lettered option under the question; a check mark or "(correct)" marks the answer.
        if (MARKS.test(m[2]) || TRAILING_MARK.test(m[2])) cur.a.push(m[2]);
        else cur.qx.push(m[2]);
        continue;
      }

      if (BULLET.test(plain)) {
        const body = plain.replace(BULLET, '');
        if (cur && cur.answering) addAnswer(body);
        else if (cur && (MARKS.test(body) || TRAILING_MARK.test(body))) cur.a.push(body); // "- \u2705 option"
        else if (cur) cur.qx.push(body);
        continue;
      }

      const pair = !(cur && cur.answering) || /\?\s*$/.test((pairOf(line, true) || [''])[0]) ? pairOf(line, true) : null;
      if (pair) {
        finish();
        if (!isHeader(pair) && !pair.every(isRule)) push(pair[0], [pair[1]]);
        continue;
      }

      if (cur && cur.answering) {
        if (cur.a.length && (isHeadingLike(plain) || (/\?$/.test(plain) && !answerMarkerAhead(li)))) {
          finish();
          if (/\?$/.test(plain)) startQ(plain, null, true);
          continue;
        }
        if (cur.loose && cur.a.length) {
          finish();
          continue;
        }
        addAnswer(plain);
        continue;
      }

      if (cur) {
        if (cur.a.length && !answerMarkerAhead(li)) {
          // Options with a check-mark answer already seen; this is a new question.
          if (/\?$/.test(plain)) startQ(plain, null, true);
          else finish();
          continue;
        }
        if (answerMarkerAhead(li)) {
          cur.qx.push(plain); // question wraps onto more lines / lists its options
          continue;
        }
        if (/\?$/.test(plain) && cur.loose) {
          startQ(plain, null, true);
          continue;
        }
        // No "Answer:" marker coming: this line is the answer.
        cur.answering = true;
        addAnswer(plain);
        if (cur.loose) finish();
        continue;
      }

      if (/\?$/.test(plain)) startQ(plain, null, true);
      else if (answerMarkerAhead(li) && !isHeadingLike(plain)) startQ(plain, null, false);
      // Anything else outside a question (intro text, headings) is ignored.
    }
    finish();
    return entries;
  }

  const api = {
    clean,
    norm,
    tokens,
    genericKind,
    answerLines,
    answerScore,
    questionScore,
    parseKey,
    solve,
  };

  root.QuizMatcher = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
