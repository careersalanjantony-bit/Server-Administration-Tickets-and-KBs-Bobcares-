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
        if (counts[0] === best) {
          Object.assign(result.shiftTimeValues, slotHits);
          result.fields.shift_time = select.name;
        } else if (counts[1] === best) {
          Object.assign(result.categoryValues, categoryHits);
          result.fields.category = select.name;
        } else {
          Object.assign(result.staffValues, staffHits);
          result.fields.staff = select.name;
        }
        if (missed.length) result.unmatched[select.name] = missed.slice(0, 12);
      });
    });

    return result;
  }

  // Text-input names S4 uses. Checked as lowercase substrings, longest hint
  // first so "duration_hour" never gets claimed by the plain "hour" rule.
  const FIELD_HINTS = [
    ["start_date", ["sdate", "startdate", "start"]],
    ["end_date", ["edate", "enddate", "end"]],
    ["duration_hours", ["dur_hr", "dur_h", "durationhour", "duration_hour", "durhour"]],
    ["duration_minutes", ["dur_min", "dur_m", "durationmin", "duration_min", "durmin"]],
    ["time_meridiem", ["ampm", "am_pm", "meridiem", "stime_ampm"]],
    ["time_hour", ["stime_hr", "time_hh", "hour", "_hr", "hh"]],
    ["time_minute", ["stime_min", "time_mm", "minute", "_min", "mm"]],
    ["reason", ["reason"]],
    ["log", ["log", "comment"]],
    ["staff", ["staff", "user", "emp", "tech"]],
  ];

  function suggestFields(forms, formName) {
    const form =
      forms.find((f) => f.name === formName) || forms[0] || { inputs: [], selects: [] };
    const names = []
      .concat((form.inputs || []).map((i) => i.name))
      .concat((form.selects || []).map((s) => s.name))
      .filter(Boolean);
    const fields = {};
    const taken = new Set();
    FIELD_HINTS.forEach(([field, hints]) => {
      for (const hint of hints) {
        const hit = names.find((n) => !taken.has(n) && n.toLowerCase().includes(hint));
        if (hit) {
          fields[field] = hit;
          taken.add(hit);
          return;
        }
      }
    });
    return fields;
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

    const body = {};
    const put = (field, value) => {
      if (fields[field]) body[fields[field]] = value;
    };
    put("staff", (mapping.staffValues || {})[payload.tech_id] || payload.tech_id);
    put("category", (mapping.categoryValues || {})[payload.category] || payload.category);
    put("start_date", payload.start_date);
    put("end_date", payload.end_date);
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

  const api = { timeKey, clean, matchOptions, suggestFields, buildBody, missingMapping };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.S4Mapping = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
