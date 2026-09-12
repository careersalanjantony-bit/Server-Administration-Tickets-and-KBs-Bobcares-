/**
 * parser.js - turns raw `cpanel-audit.sh` output (report-detailed.log /
 * audit-smart-summary.md) into the AUDIT_DATA array the autofill content
 * script consumes.
 *
 * Runs unchanged in the browser (extension popup) and in Node (CLI + tests).
 * No dependencies.
 *
 * Design note: the audit script already decides the verdict for each check
 * ("Good", "Warning", "Disabled", ...). The parser does not re-judge the
 * server - it translates those verdicts into the portal's active/inactive
 * radio plus a details string, and attaches a recommendation only when the
 * verdict is bad. Anything it cannot map is reported as unresolved rather
 * than guessed, because a wrong status in a customer audit is worse than a
 * blank one.
 */
(function (root, factory) {
  const api = factory(
    typeof require === "function" ? require("./rules.js") : root.AUDIT_RULES
  );
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.AuditParser = api;
})(typeof self !== "undefined" ? self : this, function (RULES) {
  "use strict";

  const MAX_DETAIL_LEN = 1000;

  /* ---------------------------------------------------------------- utils */

  function normalise(s) {
    return String(s == null ? "" : s)
      .toLowerCase()
      .replace(/\s+/g, " ")
      .replace(/[.:]+$/, "")
      .trim();
  }

  /** Loose key used for label lookup: alphanumerics only. */
  function labelKey(s) {
    return normalise(s).replace(/[^a-z0-9]/g, "");
  }

  // Colour codes and the status glyphs the audit script prints; both survive
  // a copy-paste out of a terminal and would otherwise break verdict matching.
  const ANSI_RE = new RegExp("\\u001b\\[[0-9;]*m", "g");
  const GLYPH_RE = new RegExp(
    "[\\u2713\\u2714\\u2716\\u2717\\u2718\\u26a0\\u2022\\u25cf\\u00d7\\ufe0f]",
    "g"
  );

  function stripAnsi(s) {
    return String(s).replace(ANSI_RE, "").replace(GLYPH_RE, " ");
  }

  /* -------------------------------------------------------------- verdicts */

  // Longest phrases first so "not configured" wins over "no".
  const VERDICT_TABLE = (function () {
    const rows = [];
    ["active", "inactive"].forEach(function (status) {
      (RULES.verdicts[status] || []).forEach(function (word) {
        rows.push({ word: normalise(word), status: status });
      });
    });
    rows.sort(function (a, b) {
      return b.word.length - a.word.length;
    });
    return rows;
  })();

  // Characters that may follow a verdict word: whitespace, dashes (ASCII,
  // en, em), colon, open paren, comma, period.
  const SEPARATOR_RE = new RegExp("[\\s\\-\\u2013\\u2014:(,.]");

  /**
   * Pull a verdict out of a value string.
   * Looks at the start of the value first ("Good - Active: ..."), then at a
   * trailing parenthesised group ("cloudlinux 8.10 (Supported)").
   * Returns { status, word, detail } or null.
   */
  function readVerdict(value) {
    const v = String(value || "").trim();
    if (!v) return null;

    const lower = normalise(v);
    for (let i = 0; i < VERDICT_TABLE.length; i++) {
      const row = VERDICT_TABLE[i];
      if (lower === row.word) {
        return { status: row.status, word: row.word, detail: "" };
      }
      if (lower.indexOf(row.word) === 0) {
        const next = lower.charAt(row.word.length);
        // Must be followed by a separator, not more of a longer word.
        if (SEPARATOR_RE.test(next)) {
          let detail = v.slice(row.word.length).trim();
          detail = detail.replace(new RegExp("^[-\\u2013\\u2014:,]+\\s*"), "").trim();
          if (/^\(.*\)$/.test(detail)) detail = detail.slice(1, -1).trim();
          return { status: row.status, word: row.word, detail: detail };
        }
      }
    }

    // Verdict inside a trailing parenthesised group.
    const paren = v.match(/\(([^()]*)\)\s*$/);
    if (paren) {
      const inner = normalise(paren[1]);
      for (let j = 0; j < VERDICT_TABLE.length; j++) {
        const row = VERDICT_TABLE[j];
        if (inner === row.word) {
          return {
            status: row.status,
            word: row.word,
            detail: v.slice(0, paren.index).trim()
          };
        }
      }
    }
    return null;
  }

  /* ----------------------------------------------------------------- parse */

  const SECTION_RE = /^\s*={2,}\s*(.+?)\s*={2,}\s*$/;
  const LINE_RE = /^\s*([^:]{1,60}?)\s*:\s*(.*?)\s*$/;

  /**
   * Parse raw report text into sections and label/value entries.
   * Splits on the FIRST colon only - values legitimately contain colons
   * ("Running (01:50:03)", "Load: 4.48").
   */
  function parseReport(text) {
    const lines = stripAnsi(String(text || "")).split(/\r?\n/);
    const sections = [];
    const entries = [];
    const index = Object.create(null);
    const sectionIndex = Object.create(null);
    let current = { name: "(preamble)", entries: [] };
    sections.push(current);

    lines.forEach(function (rawLine, i) {
      const line = rawLine.replace(/\s+$/, "");
      if (!line.trim()) return;

      const sectionMatch = line.match(SECTION_RE);
      if (sectionMatch) {
        // Drop a leading "1. " numbering so section names are comparable.
        const name = sectionMatch[1].replace(/^\d+\.\s*/, "").trim();
        current = { name: name, entries: [] };
        sections.push(current);
        return;
      }

      const m = line.match(LINE_RE);
      if (!m) return;

      const label = m[1].trim();
      const value = m[2].trim();
      if (!label) return;

      const entry = {
        label: label,
        value: value,
        section: current.name,
        lineNo: i + 1,
        verdict: readVerdict(value)
      };
      current.entries.push(entry);
      entries.push(entry);

      // First occurrence of a label wins; later duplicates stay reachable
      // through `entries` but do not shadow the canonical one.
      const key = labelKey(label);
      if (!(key in index)) index[key] = entry;

      // Section-scoped index. "Control Panel" appears in both System
      // Information (a version string) and Software Updates (a verdict);
      // the checklist item needs the one from its own section.
      const sKey = labelKey(current.name);
      if (!sectionIndex[sKey]) sectionIndex[sKey] = Object.create(null);
      if (!(key in sectionIndex[sKey])) sectionIndex[sKey][key] = entry;
    });

    return {
      sections: sections,
      entries: entries,
      index: index,
      sectionIndex: sectionIndex
    };
  }

  /* ----------------------------------------------------------- interpreters */

  function applyInterpret(mode, entry) {
    const value = entry.value;
    const verdict = entry.verdict;

    switch (mode) {
      case "count-zero-good": {
        const num = (value.match(/-?\d+/) || [])[0];
        if (num == null) {
          return verdict
            ? { status: verdict.status, detail: verdict.detail || value }
            : { status: null, detail: value };
        }
        const n = parseInt(num, 10);
        return {
          status: n === 0 ? "active" : "inactive",
          detail: n === 0 ? "No updates pending." : n + " update(s) pending."
        };
      }

      case "invert": {
        if (!verdict) return { status: null, detail: value };
        return {
          status: verdict.status === "active" ? "inactive" : "active",
          detail: verdict.detail || value
        };
      }

      case "presence": {
        const empty = (RULES.emptyValues || []).some(function (e) {
          return normalise(value) === normalise(e);
        });
        return { status: empty ? "inactive" : "active", detail: value };
      }

      case "standard":
      default:
        if (!verdict) return { status: null, detail: value };
        return { status: verdict.status, detail: verdict.detail || value };
    }
  }

  /* ------------------------------------------------------------- assembling */

  /**
   * A source is either a label string, or { label, interpret } when that
   * particular report line needs a different reading than its siblings -
   * e.g. "SSH Password Auth: enabled (yes)" means the opposite of
   * "SSH Root Access: Good".
   */
  function findEntry(report, sources, preferSection) {
    // Pass 1: restrict to the report section matching this checklist section,
    // so a label used in two sections resolves to the right one.
    // Pass 2: fall back to the whole report.
    const scoped = preferSection
      ? report.sectionIndex[labelKey(preferSection)]
      : null;

    for (let pass = 0; pass < 2; pass++) {
      const table = pass === 0 ? scoped : report.index;
      if (!table) continue;
      for (let i = 0; i < sources.length; i++) {
        const src = sources[i];
        const label = typeof src === "string" ? src : src.label;
        const explicit =
          typeof src === "object" && src.section
            ? report.sectionIndex[labelKey(src.section)]
            : null;
        const hit = (explicit || table)[labelKey(label)];
        if (hit) {
          return {
            entry: hit,
            matchedLabel: label,
            interpret: typeof src === "string" ? null : src.interpret || null
          };
        }
      }
    }
    return null;
  }

  function buildDetails(primaryDetail, item, report) {
    const parts = [];
    if (primaryDetail) parts.push(primaryDetail);
    (item.extras || []).forEach(function (label) {
      const hit = report.index[labelKey(label)];
      if (hit && hit.value) parts.push(hit.label + ": " + hit.value);
    });
    let out = parts.join(" | ").replace(/\s+/g, " ").trim();
    if (out.length > MAX_DETAIL_LEN) {
      out = out.slice(0, MAX_DETAIL_LEN - 3) + "...";
    }
    return out;
  }

  /**
   * Build the AUDIT_DATA array from raw report text.
   * Returns { items, resolved, unresolved, unmapped, system }.
   */
  function buildAuditData(text, options) {
    const opts = options || {};
    const report = parseReport(text);
    const items = [];
    const unresolved = [];
    const usedLabels = Object.create(null);

    RULES.sections.forEach(function (section) {
      section.items.forEach(function (rule) {
        const hit = findEntry(report, rule.sources || [], section.section);
        const base = {
          section: section.section,
          category: rule.category,
          titleAliases: rule.titleAliases || [rule.category],
          occurrence: rule.occurrence || 0,
          status: null,
          details: "",
          recommendation: null,
          source: null,
          raw: null,
          unresolved: true
        };

        if (!hit) {
          items.push(base);
          unresolved.push({
            section: section.section,
            category: rule.category,
            reason:
              "no report line matched any of: " +
              (rule.sources || [])
                .map(function (s) { return typeof s === "string" ? s : s.label; })
                .join(", ")
          });
          return;
        }

        usedLabels[labelKey(hit.entry.label)] = true;
        const mode = hit.interpret || rule.interpret || "standard";
        const interpreted = applyInterpret(mode, hit.entry);
        base.source = hit.entry.label;
        base.raw = hit.entry.value;
        base.details = buildDetails(interpreted.detail, rule, report);

        if (interpreted.status == null) {
          items.push(base);
          unresolved.push({
            section: section.section,
            category: rule.category,
            reason:
              'no verdict word recognised in "' +
              hit.entry.label + ": " + hit.entry.value + '"'
          });
          return;
        }

        base.status = interpreted.status;
        base.unresolved = false;
        if (interpreted.status === "inactive" && rule.recommendation) {
          base.recommendation = {
            issue: rule.recommendation.issue,
            recommendation: rule.recommendation.recommendation,
            hours: rule.recommendation.hours
          };
        }
        items.push(base);
      });
    });

    // Report lines that no checklist item consumed - the list to work from
    // when extending rules.js for a new audit-script version.
    const unmapped = report.entries
      .filter(function (e) {
        return !usedLabels[labelKey(e.label)];
      })
      .map(function (e) {
        return { section: e.section, label: e.label, value: e.value };
      });

    const system = {};
    ["Hostname", "Main IP", "rDNS", "OS / Version", "Control Panel", "System Type", "Kernel"]
      .forEach(function (label) {
        const hit = report.index[labelKey(label)];
        if (hit) system[label] = hit.value;
      });

    return {
      items:
        opts.includeUnresolved === false
          ? items.filter(function (i) { return !i.unresolved; })
          : items,
      resolved: items.filter(function (i) { return !i.unresolved; }).length,
      unresolved: unresolved,
      unmapped: unmapped,
      system: system
    };
  }

  /**
   * Accept either a pasted JSON array (already-built AUDIT_DATA) or raw
   * report text, and return the same shape either way. This is what the
   * popup uses, so pasting the report straight from the terminal works.
   */
  function parseAny(text) {
    const trimmed = String(text || "").trim();
    if (!trimmed) throw new Error("Nothing pasted.");

    if (trimmed.charAt(0) === "[" || trimmed.charAt(0) === "{") {
      let data;
      try {
        data = JSON.parse(trimmed);
      } catch (err) {
        throw new Error("That looks like JSON but will not parse: " + err.message);
      }
      const arr = Array.isArray(data) ? data : data.items || [];
      if (!Array.isArray(arr) || !arr.length) {
        throw new Error("JSON parsed, but contains no audit items.");
      }
      return {
        kind: "json",
        items: arr,
        resolved: arr.filter(function (i) { return i && i.status; }).length,
        unresolved: arr
          .filter(function (i) { return !i || !i.status; })
          .map(function (i) {
            return {
              category: (i && i.category) || "(unnamed)",
              reason: "status missing"
            };
          }),
        unmapped: [],
        system: {}
      };
    }

    const built = buildAuditData(trimmed);
    if (!built.resolved) {
      throw new Error(
        "Parsed the text as an audit report but recognised no checklist items. " +
          "Check that this is cpanel-audit.sh output (report-detailed.log)."
      );
    }
    return Object.assign({ kind: "report" }, built);
  }

  return {
    normalise: normalise,
    labelKey: labelKey,
    readVerdict: readVerdict,
    parseReport: parseReport,
    buildAuditData: buildAuditData,
    parseAny: parseAny,
    rules: RULES
  };
});
