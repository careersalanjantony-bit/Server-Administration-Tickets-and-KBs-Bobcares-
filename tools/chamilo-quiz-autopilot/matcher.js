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

  // "All of the above", "All listed steps", "None of the above", ...
  function genericKind(text) {
    const n = norm(text).replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!n || n.split(' ').length > 8) return null;
    if (/^none\b/.test(n)) return 'none';
    if (/^both (of )?(the )?above\b/.test(n)) return 'both';
    if (
      /^(all|every)\b/.test(n) &&
      (n === 'all' || /\b(above|these|statements?|listed|steps?|of them|correct|options?|mentioned|given|answers?)\b/.test(n))
    ) {
      return 'all';
    }
    return null;
  }

  // "A OR B" in an answer key means either wording is acceptable.
  function answerAlternatives(answer) {
    return String(answer).split(/\s+OR\s+/).map(clean).filter(Boolean);
  }

  // "A + B + C" / "A; B" describe several separate statements.
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
    const alts = answerAlternatives(keyAnswer);
    if (alts.length > 1) {
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

  // ---------------------------------------------------------------- solving

  /**
   * Decide which option(s) to tick for one question.
   *
   * @param {object} q        { text, extraText?, options: string[], multi: boolean }
   * @param {Array}  entries  parsed answer key [{ q, a }]
   * @returns {{ picks:number[], confidence:'high'|'low'|'none', entry, qScore, aScore, reason, ranked }}
   */
  function solve(q, entries) {
    const options = q.options || [];
    const none = (reason) => ({ picks: [], confidence: 'none', entry: null, qScore: 0, aScore: 0, reason, ranked: [] });
    if (!options.length) return none('No answer options found for this question.');
    if (!entries || !entries.length) return none('The answer key is empty.');

    const ranked = entries.map((entry) => {
      let qs = questionScore(entry.q, q.text);
      if (q.extraText) qs = Math.max(qs, 0.95 * questionScore(entry.q, q.text + ' ' + q.extraText));
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
    const base = { entry: w.entry, qScore: w.qs, aScore: w.best, ranked: ranked.slice(0, 5) };

    if (w.qs < 0.25 && !(w.best >= 0.85 && !w.generic)) {
      return Object.assign(base, { picks: [], confidence: 'none', reason: 'No answer-key question looks like this one.' });
    }

    return q.multi ? solveMulti(q, w, ranked, base) : solveSingle(q, w, ranked, base);
  }

  function solveSingle(q, w, ranked, base) {
    const options = q.options;
    let pick = w.bestIdx;
    let best = w.best;
    const reasons = [];

    // Key describes several statements ("A + B + C") and no single option
    // matches well - that is usually the "All of the above" option.
    const allIdx = options.findIndex((o) => genericKind(o) === 'all');
    const parts = answerParts(w.entry.a);
    let inferredAll = false;
    if (best < 0.55 && allIdx >= 0 && parts.length >= 2) {
      const matched = new Set();
      for (const part of parts) {
        const sc = options.map((o, i) => (i === allIdx ? 0 : textScore(part, o)));
        const bi = sc.indexOf(Math.max(...sc));
        if (sc[bi] >= 0.4) matched.add(bi);
      }
      if (matched.size >= 2) {
        pick = allIdx;
        inferredAll = true;
        reasons.push('Key lists several statements, so "' + clean(options[allIdx]) + '" was chosen.');
      }
    }

    if (best < 0.35 && !inferredAll) {
      return Object.assign(base, {
        picks: [],
        confidence: 'none',
        reason: 'Question matched, but none of the options looks like the key answer "' + clean(w.entry.a) + '".',
      });
    }

    let confident = !inferredAll;
    if (confident && !((w.qs >= 0.5 && best >= 0.5) || (w.qs >= 0.3 && best >= 0.8 && !w.generic))) {
      confident = false;
      reasons.push('Weak match.');
    }
    if (confident && !(best - w.second >= 0.12 || (best >= 0.95 && w.second < 0.9))) {
      confident = false;
      reasons.push('Two options look almost equally right.');
    }
    if (confident) {
      const rival = ranked.find((r) => r !== w && r.bestIdx !== pick && r.best >= 0.35);
      if (rival && rival.combined >= w.combined - 0.06) {
        confident = false;
        reasons.push('Another key entry ("' + clean(rival.entry.q) + '") points to a different option.');
      }
    }
    if (confident) {
      // A second key entry for this same question that accepts two of the options ("A OR B").
      const shaky = ranked.find(
        (r) => r !== w && r.qs >= 0.4 && r.qs >= w.qs - 0.45 && r.second >= 0.5 && r.best - r.second < 0.12
      );
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
      const parts = answerParts(w.entry.a);
      for (const part of parts.length > 1 ? parts : [w.entry.a]) {
        const sc = options.map((o) => answerScore(part, o));
        const bi = sc.indexOf(Math.max(...sc));
        if (sc[bi] >= 0.45) picks.add(bi);
        if (sc[bi] < 0.55) allGood = false;
      }
      // Options that match the whole key answer strongly are ticked as well.
      w.scores.forEach((s, i) => {
        if (s >= 0.8) picks.add(i);
      });
    }

    const list = [...picks].sort((a, b) => a - b);
    if (!list.length) {
      return Object.assign(base, { picks: [], confidence: 'none', reason: 'No option matches the key answer "' + clean(w.entry.a) + '".' });
    }
    const confident = allGood && w.qs >= 0.5;
    return Object.assign(base, {
      picks: list,
      confidence: confident ? 'high' : 'low',
      reason: confident ? '' : 'Multiple-choice question - please double-check the ticked options.',
    });
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

  /**
   * Parse a pasted answer key. Supported formats (can be mixed):
   *   | 1 | Question | Answer |          (markdown table, # column optional)
   *   Question | Answer
   *   Question => Answer   (also ->, ::, or a TAB)
   *   Q: Question  /  A: Answer          (on separate lines)
   *   **1. Question**  /  **Answer:** x  (numbered question, "Answer:" line; bold is ignored)
   *   Question?  /  Answer               (question line ending in "?", answer on the next line)
   *   JSON: [{"q": "...", "a": "..."}]  or  {"question": "answer"}
   */
  function parseKey(text) {
    const entries = [];
    const seen = new Set();
    const push = (q, a) => {
      q = clean(q).replace(/^(?:q(?:uestion)?\s*\d*\s*[:.)]|\d+\s*[.)])\s*/i, '');
      a = clean(a).replace(/^(?:a(?:ns(?:wer)?)?\s*[:=]\s*)/i, '');
      if (!q || !a) return;
      const id = norm(q) + '\u0000' + norm(a);
      if (seen.has(id)) return;
      seen.add(id);
      entries.push({ q, a });
    };

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

    const Q_RE = /^(?:(?:q|question)\s*\d*\s*[:.)]|\d+\s*[.)])\s*(.+)$/i; // "Q: ..", "Question 3: ..", "3. .."
    const A_RE = /^(?:a|ans|answer|correct answer|right answer|correct)\s*[:=]\s*(.*)$/i;
    const isHeader = (p) =>
      /^(#|no\.?|question)$/i.test(p[0]) || (/question/i.test(p[0]) && p[0].length < 20 && /answer/i.test(p[1]));

    // "question | answer" or "question => answer" on one line; null if the line is not a pair.
    const pairOf = (s) => {
      if (s.includes('|')) {
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

    let pendingQ = null;
    let loose = false; // pending question may take a plain next line as its answer
    let wantAnswer = false; // saw a bare "Answer:" - the text is on the next line
    const setQ = (q, isLoose) => {
      pendingQ = q;
      loose = isLoose;
      wantAnswer = false;
    };
    const take = (a) => {
      push(pendingQ, a);
      setQ(null, false);
    };

    for (const raw of t.split('\n')) {
      const line = raw.trim();
      if (!line || /^```/.test(line) || /^#{1,6}\s/.test(line) || /^([-*_])\1{2,}$/.test(line)) continue;
      const plain = line.replace(/\*\*|__/g, '').trim(); // "**Answer:** x" -> "Answer: x"
      let m;

      if (pendingQ && wantAnswer) {
        take(plain);
        continue;
      }
      if (pendingQ && (m = plain.match(A_RE))) {
        if (m[1].trim()) take(m[1]);
        else wantAnswer = true;
        continue;
      }

      if (line.startsWith('|')) {
        const pair = pairOf(line);
        if (pair && !isHeader(pair) && !pair.every((c) => /^:?-{2,}:?$/.test(c))) push(pair[0], pair[1]);
        setQ(null, false);
        continue;
      }

      if ((m = plain.match(Q_RE))) {
        const pair = pairOf(m[1]);
        if (pair && !isHeader(pair)) {
          push(pair[0], pair[1]);
          setQ(null, false);
        } else {
          setQ(m[1], false);
        }
        continue;
      }

      const pair = pairOf(line);
      if (pair) {
        if (!isHeader(pair)) push(pair[0], pair[1]);
        setQ(null, false);
        continue;
      }
      if (/\?$/.test(plain)) {
        setQ(plain, true);
        continue;
      }
      if (pendingQ && loose) take(plain);
    }
    return entries;
  }

  const api = {
    clean,
    norm,
    tokens,
    genericKind,
    answerScore,
    questionScore,
    parseKey,
    solve,
  };

  root.QuizMatcher = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
