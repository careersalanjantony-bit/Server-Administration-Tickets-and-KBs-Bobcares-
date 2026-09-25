/*
 * Working out which of S4's dropdown options means which shift.
 *
 * The slot labels in the planner's shifts.json were transcribed from S4's own
 * column headers, so they match its dropdown text directly — which is why none
 * of this has to be typed out by hand. The one wrinkle is that S4 is not
 * consistent about leading zeros ("7:00am-3:00pm" in one column,
 * "07:02am-03:02pm" in the next), so times are compared on parsed values.
 *
 * Kept in its own file so the same logic is used by the probe and the filler,
 * and can be unit-tested outside the browser.
 */
(function (root) {
  "use strict";

  const TIME = /(\d{1,2}):(\d{2})\s*([ap]m)/gi;

  function timeKey(text) {
    const parts = [];
    let match;
    TIME.lastIndex = 0;
    while ((match = TIME.exec(text || "")) !== null) {
      parts.push(`${parseInt(match[1], 10)}:${match[2]}${match[3].toLowerCase()}`);
    }
    return parts.join("-");
  }

  function clean(text) {
    return (text || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  /**
   * @param {Array} forms    probeForms() output
   * @param {Object} plan    the plan.json the planner wrote
   * @returns {Object} {fields, shiftTimeValues, categoryValues, staffValues, unmatched}
   */
  function matchOptions(forms, plan) {
    const slots = plan.slots || [];
    const categories = plan.categories || {};
    const techs = plan.techs || [];

    const slotByTime = new Map();
    const slotByName = new Map();
    slots.forEach((slot) => {
      const key = timeKey(slot.label);
      if (key) slotByTime.set(key, slot.id);
      slotByName.set(clean(slot.label), slot.id);
    });
    const categoryByName = new Map(
      Object.entries(categories).map(([code, name]) => [clean(name), code])
    );
    const categoryByCode = new Map(Object.keys(categories).map((code) => [clean(code), code]));
    const techByName = new Map();
    techs.forEach((tech) => {
      [tech.id, tech.display_name, tech.email ? tech.email.split("@")[0] : ""]
        .filter(Boolean)
        .forEach((alias) => techByName.set(clean(alias), tech.id));
    });

    const result = {
      fields: {},
      shiftTimeValues: {},
      categoryValues: {},
      staffValues: {},
      unmatched: {},
    };

    const best_ = {};
    forms.forEach((form) => {
      (form.selects || []).forEach((select) => {
        const options = (select.options || []).filter((o) => (o.text || "").trim());
        if (!options.length) return;

        const slotHits = {};
        const categoryHits = {};
        const staffHits = {};
        const missed = [];

        options.forEach((option) => {
          const text = (option.text || "").trim();
          const value = option.value != null ? String(option.value) : "";
          const slotId = slotByTime.get(timeKey(text)) || slotByName.get(clean(text));
          let code = categoryByName.get(clean(text));
          // S4 writes categories as "Working Day(W)" — and "Off" in mixed
          // case, which an upper-case-only match missed.
          const bracketed = /^(.*?)\(([^()]+)\)\s*$/.exec(text);
          if (!code && bracketed) {
            code = categoryByCode.get(clean(bracketed[2])) ||
              categoryByName.get(clean(bracketed[1]));
          }
          const techId = techByName.get(clean(text));

          if (slotId) slotHits[slotId] = value;
          else if (code) categoryHits[code] = value;
          else if (techId) staffHits[techId] = value;
          else missed.push(text);
        });

        const counts = [
          Object.keys(slotHits).length,
          Object.keys(categoryHits).length,
          Object.keys(staffHits).length,
        ];
        const best = Math.max.apply(null, counts);
        if (best === 0) {
          result.unmatched[select.name] = missed.slice(0, 40);
          return;
        }
        // Only the dropdown with the most matches gets to name the field. A
        // page can carry several: edit_team has the whole user list, the team's
        // own members, and a seven-strong team-admin list — and the admin list
        // was ending up as the staff field name.
        const claim = (kind, hits, values) => {
          Object.assign(values, hits);
          const size = Object.keys(hits).length;
          if (size > (best_[kind] || 0)) {
            best_[kind] = size;
            result.fields[kind] = select.name;
          }
        };
        if (counts[0] === best) claim("shift_time", slotHits, result.shiftTimeValues);
        else if (counts[1] === best) claim("category", categoryHits, result.categoryValues);
        else claim("staff", staffHits, result.staffValues);
        if (missed.length) result.unmatched[select.name] = missed.slice(0, 40);
      });
    });

    return result;
  }

  // Field names S4 actually uses, read off the change_shift form. Checked as
  // lowercase substrings, longest hint first so "duration_h" is never claimed
  // by the plain "hour" rule. `avoid` keeps a name off a control that cannot
  // hold the value: "log" was binding to shift_comment, a group of seven radio
  // buttons, simply because the name contains "comment".
  const FIELD_HINTS = [
    ["start_date", ["sdate", "startdate"]],
    ["end_date", ["edate", "enddate"]],
    // S4 carries the date twice: once whole, once split into three. Which one
    // it reads is its business — both are filled so it does not matter.
    ["start_day", ["startday"]],
    ["start_month", ["startmonth"]],
    ["start_year", ["startyear"]],
    ["end_day", ["endday"]],
    ["end_month", ["endmonth"]],
    ["end_year", ["endyear"]],
    // S4 spells these duration_h / duration_m — note that "duration_h" does
    // not contain "dur_h", which is why they went unmatched for so long.
    ["duration_hours", ["duration_h", "dur_hr", "dur_h", "durationhour", "durhour"]],
    ["duration_minutes", ["duration_m", "dur_min", "dur_m", "durationmin", "durmin"]],
    ["time_meridiem", ["ampm", "am_pm", "meridiem"]],
    ["time_hour", ["stime_hr", "time_hh", "hour", "_hr", "hh"]],
    ["time_minute", ["stime_min", "time_mm", "minute", "_min", "mm"]],
    // Named as well as matched by its options, because the dropdown comes
    // back empty unless the page was opened against a real calendar row.
    ["shift_time", ["shift_time", "shifttime"]],
    ["category", ["cat", "category"]],
    ["staff", ["uid", "staff", "emp", "tech", "member"]],
    // reasonComment is hidden and carries the row's existing comment back to
    // S4; it is S4's to fill, not ours.
    ["reason", ["reasoncomment", "reason"], ["radio", "checkbox", "submit", "button", "hidden"]],
    ["log", ["comment", "log"], ["radio", "checkbox", "submit", "button", "hidden"]],
  ];

  function suggestFields(forms, formName) {
    // Look through every form, named one first. On S4's month page the
    // <form name="shift"> is empty and the controls sit loose in the document,
    // so stopping at the named form would find nothing at all.
    const ordered = (forms || [])
      .filter((f) => f.name === formName)
      .concat((forms || []).filter((f) => f.name !== formName));
    const controls = [];
    ordered.forEach((form) => {
      (form.inputs || []).forEach((i) => {
        if (i.name) controls.push({ name: i.name, type: (i.type || "text").toLowerCase() });
      });
      (form.selects || []).forEach((s) => {
        if (s.name) controls.push({ name: s.name, type: "select" });
      });
    });
    const fields = {};
    const taken = new Set();
    FIELD_HINTS.forEach(([field, hints, avoid]) => {
      for (const hint of hints) {
        const hit = controls.find(
          (c) =>
            !taken.has(c.name) &&
            c.name.toLowerCase().includes(hint) &&
            !(avoid && avoid.indexOf(c.type) !== -1)
        );
        if (hit) {
          fields[field] = hit.name;
          taken.add(hit.name);
          return;
        }
      }
    });
    return fields;
  }

  const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                        "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  /** "01-Oct-2026" -> {day: "01", month: "10", year: "2026"} */
  function splitDate(text) {
    const parts = String(text || "").split("-");
    if (parts.length !== 3) return null;
    const month = MONTHS_SHORT.indexOf(parts[1]);
    if (month < 0) return null;
    return {
      day: parts[0],
      month: String(month + 1).padStart(2, "0"),
      year: parts[2],
      iso: `${parts[2]}-${String(month + 1).padStart(2, "0")}-${parts[0]}`,
    };
  }

  /** Build the form-encoded body for one planned shift block. */
  function buildBody(payload, mapping) {
    const fields = mapping.fields || {};
    const [hourText, minuteText] = String(payload.time || "00:00").split(":");
    const hour = parseInt(hourText, 10);
    const meridiem = hour < 12 ? "am" : "pm";
    const displayHour = hour % 12 === 0 ? 12 : hour % 12;
    const duration = parseInt(payload.duration_min, 10) || 480;
    const durationHours = Math.floor(duration / 60);
    const durationMinutes = duration % 60;

    // Start from the form's own hidden inputs and their values. A classic PHP
    // form expects everything it rendered to come back; sending only the
    // fields we understand drops cal_id, tid and the rest, and S4 has no way
    // to tell which row is being changed.
    const body = Object.assign({}, mapping.baseFields || {});
    const put = (field, value) => {
      if (fields[field]) body[fields[field]] = value;
    };
    put("staff", (mapping.staffValues || {})[payload.tech_id] || payload.tech_id);
    put("category", (mapping.categoryValues || {})[payload.category] || payload.category);
    const from = splitDate(payload.start_date);
    const to = splitDate(payload.end_date);
    // Send the date in whatever shape S4 itself rendered. The visible box
    // shows 01-Oct-2026 while the hidden one holds 2026-10-01, and guessing
    // wrong silently writes the wrong day.
    const asRendered = (field, plain, parsed) => {
      const existing = (mapping.baseFields || {})[fields[field]];
      const iso = /^\d{4}-\d{2}-\d{2}$/.test(existing || "");
      return iso && parsed ? parsed.iso : plain;
    };
    // Where the form splits the date into day, month and year, those are the
    // range being changed, and sdate/edate are only the grid view S4 returns
    // to afterwards (the whole month). Left as rendered, as a person saving
    // the editor would leave them.
    const split = fields.start_day && fields.end_day;
    if (!split) {
      put("start_date", asRendered("start_date", payload.start_date, from));
      put("end_date", asRendered("end_date", payload.end_date, to));
    }
    if (from) {
      put("start_day", from.day);
      put("start_month", from.month);
      put("start_year", from.year);
    }
    if (to) {
      put("end_day", to.day);
      put("end_month", to.month);
      put("end_year", to.year);
    }
    put(
      "shift_time",
      (mapping.shiftTimeValues || {})[payload.slot_id || ""] || payload.shift_time
    );
    put("time_hour", String(displayHour));
    put("time_minute", minuteText);
    put("time_meridiem", meridiem);
    put("duration_hours", String(durationHours));
    put("duration_minutes", String(durationMinutes).padStart(2, "0"));
    // Comments are left as S4 rendered them. The popup hands the row's
    // existing note back in reasonComment, and overwriting either would lose
    // what a person wrote there ("nischitha.ns req"). Opt in with
    // mapping.writeComments.
    if (mapping.writeComments) {
      put("reason", payload.reason || "");
      put("log", payload.reason || "");
    }
    Object.assign(body, mapping.constantFields || {});
    return body;
  }

  /**
   * The hidden values a form rendered, to be handed straight back.
   *
   * Passwords are never taken, and the submit button is kept because PHP
   * commonly tests for it to decide the form was submitted at all.
   */
  function baseFieldsOf(forms, formName) {
    const form =
      (forms || []).find((f) => f.name === formName) || (forms || [])[0] || { inputs: [] };
    // Exactly what a browser would send when the editor's Edit button is
    // pressed: every enabled control, empty text included, ticked boxes only,
    // one submit button, and never a plain button or a password.
    const base = {};
    let submitted = false;
    (form.inputs || []).forEach((input) => {
      const type = (input.type || "text").toLowerCase();
      if (!input.name || input.disabled) return;
      if (["password", "button", "reset", "file", "image"].indexOf(type) !== -1) return;
      if (type === "radio" || type === "checkbox") {
        // Only what is ticked is submitted. Echoing every option would post
        // the last one — the probe showed hcl_co=NB and shift_comment=2 going
        // out on every row whether or not either was selected.
        if (input.checked) base[input.name] = input.value || "on";
        return;
      }
      if (type === "submit") {
        if (!submitted) base[input.name] = input.value || "";
        submitted = true;
        return;
      }
      base[input.name] = input.value || "";
    });
    // A dropdown is submitted with whatever it shows. Leaving the ones the
    // mapping does not fill out of the post would blank them on S4's side.
    (form.selects || []).forEach((select) => {
      if (!select.name || select.disabled) return;
      if (select.selected === undefined || select.selected === null) return;
      if (!(select.name in base)) base[select.name] = String(select.selected);
    });
    return base;
  }

  // ------------------------------------------------------------ the grid
  //
  // Every cell in S4's month grid opens its editor through
  //   popup(cal_id, date, user, team, time, duration, cat_id,
  //         start_date, end_date, co_flag, comment, referer_team_id)
  // which window.open()s index.php?action=chkshift with those values in the
  // query string. cal_id is per person per day, so the grid is the only place
  // to learn which row a shift block has to change.

  const KNOWN_POPUP_PARAMS = [
    "cal_id", "date", "user", "team", "time", "duration", "cat_id",
    "start_date", "end_date", "co_flag", "comment", "referer_team_id",
  ];

  function readQuoted(text, i) {
    const quote = text[i];
    let value = "";
    i += 1;
    while (i < text.length && text[i] !== quote) {
      if (text[i] === "\\" && i + 1 < text.length) {
        value += text[i + 1];
        i += 2;
        continue;
      }
      value += text[i];
      i += 1;
    }
    return { value, next: i + 1 };
  }

  /** The arguments of a call, given the text just after its "(". */
  function parseCallArgs(text) {
    const args = [];
    let current = "";
    let depth = 0;
    let i = 0;
    while (i < text.length) {
      const ch = text[i];
      if (ch === "'" || ch === '"') {
        const quoted = readQuoted(text, i);
        current += quoted.value;
        i = quoted.next;
        continue;
      }
      if (ch === "(") depth += 1;
      if (ch === ")") {
        if (depth === 0) {
          if (current.trim() !== "" || args.length) args.push(current.trim());
          return args;
        }
        depth -= 1;
      }
      if (ch === "," && depth === 0) {
        args.push(current.trim());
        current = "";
        i += 1;
        continue;
      }
      current += ch;
      i += 1;
    }
    return null;
  }

  /** "a"+x+"b" as literal and parameter parts, up to a top-level , or ). */
  function parseConcat(text) {
    const parts = [];
    let i = 0;
    while (i < text.length) {
      const ch = text[i];
      if (/[\s+]/.test(ch)) {
        i += 1;
        continue;
      }
      if (ch === "," || ch === ")") return parts.length ? parts : null;
      if (ch === "'" || ch === '"') {
        const quoted = readQuoted(text, i);
        parts.push({ lit: quoted.value });
        i = quoted.next;
        continue;
      }
      const ident = /^[A-Za-z_$][\w$.]*/.exec(text.slice(i));
      if (!ident) return null;
      i += ident[0].length;
      if (text[i] === "(") {
        // encodeURIComponent(comment) and the like: take the inner name.
        const close = text.indexOf(")", i);
        if (close < 0) return null;
        parts.push({ ref: text.slice(i + 1, close).trim(), wrap: ident[0] });
        i = close + 1;
        continue;
      }
      parts.push({ ref: ident[0] });
    }
    return null;
  }

  /** popup()'s parameter names and the address it opens, read off the page. */
  function popupSignature(html) {
    const def = /function\s+popup\s*\(([^)]*)\)/.exec(html || "");
    if (!def) return null;
    const params = def[1].split(",").map((p) => p.trim()).filter(Boolean);
    const body = html.slice(def.index, def.index + 4000);
    const open = /window\.open\s*\(/.exec(body);
    const template = open ? parseConcat(body.slice(open.index + open[0].length)) : null;
    return { params, template, source: body.slice(0, 1200) };
  }

  /** The editor address for one grid cell, built the way popup() builds it. */
  function editorUrl(cell, signature) {
    const values = Object.assign({}, cell);
    // popup() falls back to the cell's own team when no referer is given.
    if (!values.referer_team_id && values.team) values.referer_team_id = values.team;
    const value = (name) =>
      values[name] === undefined || values[name] === null ? "" : String(values[name]);
    const template = signature && signature.template;
    if (template && template.length) {
      return template
        .map((part) => (part.lit !== undefined ? part.lit : encodeURIComponent(value(part.ref))))
        .join("");
    }
    const pairs = [
      ["cal_id", "cal_id"], ["cal_date", "date"], ["cal_user_id", "user"],
      ["cal_team_id", "team"], ["cal_time", "time"], ["cal_duration", "duration"],
      ["cal_cat_id", "cat_id"], ["sdate", "start_date"], ["edate", "end_date"],
      ["co_flag", "co_flag"], ["comment", "comment"], ["referer_team_id", "referer_team_id"],
    ];
    return (
      "index.php?action=chkshift&" +
      pairs.map(([key, param]) => `${key}=${encodeURIComponent(value(param))}`).join("&")
    );
  }

  const pad2 = (n) => String(n).padStart(2, "0");

  /** Any date S4 might hand a cell, as YYYY-MM-DD. */
  function normaliseDate(text) {
    const t = String(text || "").trim();
    let m;
    if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(t))) return `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;
    if ((m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(t))) {
      const month = MONTHS_SHORT.findIndex((x) => x.toLowerCase() === m[2].toLowerCase());
      if (month >= 0) return `${m[3]}-${pad2(month + 1)}-${pad2(m[1])}`;
    }
    // S4 is an Indian system; a slashed date is day first.
    if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t))) return `${m[3]}-${pad2(m[2])}-${pad2(m[1])}`;
    if ((m = /^(\d{4})(\d{2})(\d{2})$/.exec(t))) return `${m[1]}-${m[2]}-${m[3]}`;
    if (/^\d{9,10}$/.test(t)) {
      const d = new Date(Number(t) * 1000);
      return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    }
    return null;
  }

  /**
   * user|YYYY-MM-DD -> the cell for that person on that day.
   *
   * Somebody on two teams has a cell in each team's grid. When `team` is
   * given, that team's cell wins; otherwise the first one read is kept.
   */
  function indexCells(cells, team) {
    const index = {};
    let duplicates = 0;
    const ours = (cell) =>
      team !== undefined && team !== null && String(cell.team) === String(team);
    (cells || []).forEach((cell) => {
      const iso = normaliseDate(cell.date);
      if (!iso || !cell.user) return;
      const key = `${cell.user}|${iso}`;
      if (index[key]) {
        duplicates += 1;
        if (ours(cell) && !ours(index[key])) index[key] = cell;
        return;
      }
      index[key] = cell;
    });
    return { index, duplicates };
  }

  /** A grid cell's time, "65800" or "070000" (HHMMSS), as "06:58". */
  function cellTime(text) {
    const digits = String(text || "").replace(/\D/g, "");
    if (!digits) return null;
    const padded = digits.padStart(6, "0").slice(-6);
    return `${padded.slice(0, 2)}:${padded.slice(2, 4)}`;
  }

  /** "06:58am-02:58pm" -> "06:58", "3:00pm-11:00pm" -> "15:00"; Flexy -> null. */
  function labelStart(label) {
    const m = /(\d{1,2}):(\d{2})\s*([ap]m)/i.exec(label || "");
    if (!m) return null;
    let hour = parseInt(m[1], 10) % 12;
    if (m[3].toLowerCase() === "pm") hour += 12;
    return `${String(hour).padStart(2, "0")}:${m[2]}`;
  }

  /** Every date a block covers, as YYYY-MM-DD. */
  function blockDays(payload) {
    const from = splitDate(payload.start_date);
    const to = splitDate(payload.end_date || payload.start_date);
    if (!from || !to) return [];
    const days = [];
    const at = new Date(Date.UTC(+from.year, +from.month - 1, +from.day));
    const end = Date.UTC(+to.year, +to.month - 1, +to.day);
    while (at.getTime() <= end && days.length < 62) {
      days.push(at.toISOString().slice(0, 10));
      at.setUTCDate(at.getUTCDate() + 1);
    }
    return days;
  }

  // Categories whose rows carry a shift time. The editor itself only shows
  // the time fields for these (show_details(): cat 1, 2 and 28).
  const TIMED = new Set(["W", "ITW", "NB"]);

  /**
   * What S4 already holds for a block, read off the grid.
   *
   * Each cell's popup() call carries that day's time, duration and category,
   * so the grid alone says whether a block would change anything.
   */
  function compareBlock(payload, uid, index, categoryValues) {
    const byValue = {};
    Object.entries(categoryValues || {}).forEach(([code, value]) => {
      byValue[String(value)] = code;
    });
    const days = blockDays(payload);
    const differ = [];
    let seen = 0;
    days.forEach((iso) => {
      const cell = index[`${uid}|${iso}`];
      if (!cell) return;
      seen += 1;
      const category = byValue[String(cell.cat_id)] || `cat ${cell.cat_id}`;
      const time = cellTime(cell.time);
      const sameCategory = category === payload.category;
      const sameTime =
        !TIMED.has(payload.category) ||
        (time === payload.time &&
          String(cell.duration || "") === String(payload.duration_min || ""));
      if (!(sameCategory && sameTime)) {
        differ.push(`${iso} S4 has ${TIMED.has(category) ? `${time} ` : ""}${category}`);
      }
    });
    return { same: seen === days.length && seen > 0 && !differ.length, seen, days, differ };
  }

  /** Which mappings are still missing before a live run is safe. */
  function missingMapping(mapping, plan) {
    const required = [
      "staff", "category", "start_date", "end_date", "shift_time",
      "time_hour", "time_minute", "duration_hours", "duration_minutes",
    ];
    const fields = mapping.fields || {};
    const missing = required.filter((f) => !fields[f]);
    const slotIds = new Set(
      (plan.assignments || []).map((a) => a.slot_id).filter(Boolean)
    );
    const unmappedSlots = [...slotIds].filter(
      (id) => !(mapping.shiftTimeValues || {})[id]
    );
    const categories = new Set((plan.assignments || []).map((a) => a.category));
    const unmappedCategories = [...categories].filter(
      (c) => !(mapping.categoryValues || {})[c]
    );
    return { fields: missing, slots: unmappedSlots, categories: unmappedCategories };
  }

  const api = {
    timeKey, clean, matchOptions, suggestFields, buildBody, missingMapping,
    splitDate, baseFieldsOf,
    KNOWN_POPUP_PARAMS, parseCallArgs, parseConcat, popupSignature, editorUrl,
    normaliseDate, indexCells, cellTime, blockDays, compareBlock, labelStart,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.S4Mapping = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
