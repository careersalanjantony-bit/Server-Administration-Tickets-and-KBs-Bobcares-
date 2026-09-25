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
          if (!code) {
            // S4 writes categories as "Working Day(W)".
            const bracketed = text.match(/\(([A-Z]{1,3})\)/);
            if (bracketed && categories[bracketed[1]]) code = bracketed[1];
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
          result.unmatched[select.name] = missed.slice(0, 12);
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
        if (missed.length) result.unmatched[select.name] = missed.slice(0, 12);
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
    ["reason", ["reasoncomment", "reason"], ["radio", "checkbox", "submit", "button"]],
    ["log", ["comment", "log"], ["radio", "checkbox", "submit", "button"]],
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
    put("start_date", asRendered("start_date", payload.start_date, from));
    put("end_date", asRendered("end_date", payload.end_date, to));
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
    put("reason", payload.reason || "");
    put("log", payload.reason || "");
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
    const base = {};
    (form.inputs || []).forEach((input) => {
      const type = (input.type || "text").toLowerCase();
      if (!input.name || type === "password") return;
      if (type === "hidden" || type === "submit") {
        base[input.name] = input.value || "";
      } else if (input.value) {
        base[input.name] = input.value;
      }
    });
    return base;
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
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.S4Mapping = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
