/*
 * Holds the plan, the field mapping and the run state.
 *
 * This lives in the background rather than the popup because the popup is torn
 * down the moment it loses focus — a run driven from there would die as soon as
 * the person clicked away. Progress is written to storage as it goes, so the
 * popup can be closed and reopened mid-run.
 */
"use strict";

const LOG_LIMIT = 1200;

const DEFAULT_STATE = {
  log: [],
  probing: false,
  plan: null,
  mapping: null,
  run: {
    running: false,
    dryRun: true,
    index: 0,
    total: 0,
    results: [],
    startedAt: null,
    finishedAt: null,
    stopped: false,
    note: "",
    current: null,
  },
  // Writing is off until somebody deliberately turns it on. A dry run is
  // the common case and a mis-click on the live button would otherwise go
  // straight into a roster people are working to.
  settings: { delayMs: 700, stopAfterFailures: 3, allowWrites: false, editUrl: "" },
};

let state = JSON.parse(JSON.stringify(DEFAULT_STATE));
let stopRequested = false;

/**
 * Append-only record of what the extension did.
 *
 * Everything here has, at some point, been something somebody had to describe
 * from a screenshot: which pages were read, what the mapping came back with,
 * why a button was refused, what S4 said to each post. Keeping it means the
 * next question can be answered from the log instead of guessed at.
 */
function note(level, message, detail) {
  if (!state.log) state.log = [];
  state.log.push({
    t: new Date().toISOString(),
    level,
    message,
    detail: detail === undefined ? null : detail,
  });
  if (state.log.length > LOG_LIMIT) {
    state.log.splice(0, state.log.length - LOG_LIMIT);
  }
}

async function load() {
  const saved = await browser.storage.local.get("state");
  if (saved && saved.state) state = Object.assign({}, state, saved.state);

  // A persisted "running" cannot be true. This background page has only just
  // started, so whatever loop set that flag is long gone — and every control
  // in the UI keys off it, so leaving it set locks the page permanently.
  state.probing = false;
  if (state.run && state.run.running) {
    state.run.running = false;
    state.run.stopped = true;
    state.run.note =
      `The previous run stopped after ${state.run.index || 0} of ` +
      `${state.run.total || 0} when the extension reloaded. Nothing further was sent.`;
    note("warn", "Cleared a run left flagged as going", {
      reached: state.run.index || 0,
      of: state.run.total || 0,
    });
    await browser.storage.local.set({ state });
  }
}
const ready = load().then(() => note("info", "Extension started"));

async function save() {
  await browser.storage.local.set({ state });
}

/*
 * The UI is a tab, not a popup.
 *
 * Firefox closes a browser_action popup the moment it loses focus, and opening
 * the file picker does exactly that — the popup was torn down mid-load and the
 * plan never reached the background. A tab survives all of it, and a run that
 * takes several minutes is easier to watch in one anyway.
 */
const UI_PATH = "ui/ui.html";

async function openUi() {
  const url = browser.runtime.getURL(UI_PATH);
  const open = await browser.tabs.query({ url });
  if (open.length) {
    await browser.tabs.update(open[0].id, { active: true });
    if (browser.windows) {
      try {
        await browser.windows.update(open[0].windowId, { focused: true });
      } catch (error) {
        /* the window may be gone; focusing the tab was the important part */
      }
    }
    return open[0];
  }
  return browser.tabs.create({ url });
}

if (browser.browserAction && browser.browserAction.onClicked) {
  browser.browserAction.onClicked.addListener(openUi);
}

async function s4Tabs() {
  const tabs = (await browser.tabs.query({ url: "*://s4.inhouse.net/*" })).filter(
    (tab) => !(tab.url || "").startsWith(browser.runtime.getURL(""))
  );
  if (!tabs.length) {
    throw new Error("No S4 tab is open. Open the shift page in a tab and try again.");
  }
  return tabs;
}

async function askTab(tabId, message) {
  try {
    return await browser.tabs.sendMessage(tabId, message);
  } catch (error) {
    throw new Error(
      "Could not reach the S4 page. Reload the S4 tab so the extension loads into it, " +
        `then try again. (${error.message})`
    );
  }
}

/** Talk to the tab the probe settled on, or the only one there is. */
async function ask(message) {
  const tabs = await s4Tabs();
  const chosen =
    (state.mapping && tabs.find((t) => t.id === state.mapping.tabId)) || tabs[0];
  return askTab(chosen.id, message);
}

/**
 * How useful a page's forms look.
 *
 * S4 spreads this over two windows: the month grid holds an empty
 * <form name="shift">, and the edit popup holds the controls that matter. So
 * rather than making somebody pick the right window, every open S4 tab is
 * probed and the one carrying the real form wins.
 */
/**
 * Addresses the editor is likely to live at, built rather than scraped.
 *
 * S4 opens the editor from javascript that assembles the url out of pieces, so
 * there is no whole address in the markup to find. The shape is known though —
 * index.php?action=view_shift&sdate=…&edate=…&t=…&edit_co_shift=N — and the
 * plan carries both the month and the team, so it can simply be written out.
 */
function constructedCandidates(plan, origin) {
  if (!plan || !plan.month) return [];
  const [year, month] = plan.month.split("-").map(Number);
  if (!year || !month) return [];
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const first = `${plan.month}-01`;
  const last = `${plan.month}-${String(lastDay).padStart(2, "0")}`;
  const team = plan.team_id;
  const urls = [];
  const add = (query) => urls.push(`${origin}/index.php?${query}`);
  if (team !== undefined && team !== null) {
    // The plan month's grid carries a calendar row for every person and day.
    add(`action=view_shift&t=${team}&y=${year}&m=${month}`);
    add(`action=view_shift&sdate=${first}&edate=${last}&t=${team}&edit_co_shift=N`);
    add(`action=view_shift&sdate=${first}&edate=${last}&t=${team}&edit_co_shift=Y`);
  }
  add(`action=view_shift&sdate=${first}&edate=${last}&edit_co_shift=N`);
  return urls;
}

const REQUIRED_FIELDS = [
  "staff", "category", "start_date", "end_date", "shift_time",
  "time_hour", "time_minute", "duration_hours", "duration_minutes",
];

/**
 * What one page is worth.
 *
 * Counting matches rewarded the wrong page: action=edit_timings matched
 * fourteen shift times and scored highest, while add_shift — which carries the
 * staff list and is plainly the form that posts a shift — scored lower with no
 * shift times on it. What matters is how many of the fields a post actually
 * needs a page can supply, so that is what is counted first.
 */
function readPage(forms, plan) {
  const matched = S4Mapping.matchOptions(forms, plan);
  const fields = Object.assign(
    S4Mapping.suggestFields(forms, plan.form_name || "shift"),
    matched.fields
  );
  const requiredFields = REQUIRED_FIELDS.filter((name) => fields[name]).length;
  return {
    fields,
    matched,
    requiredFields,
    shiftTimes: Object.keys(matched.shiftTimeValues).length,
    categories: Object.keys(matched.categoryValues).length,
    staff: Object.keys(matched.staffValues).length,
    // Kept only as a tie-break between pages that supply the same fields.
    weight:
      Object.keys(matched.shiftTimeValues).length +
      Object.keys(matched.categoryValues).length +
      Object.keys(matched.staffValues).length,
  };
}

function betterPage(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (b.requiredFields !== a.requiredFields) {
    return b.requiredFields > a.requiredFields ? b : a;
  }
  return b.weight > a.weight ? b : a;
}

function isComplete(read) {
  return read && read.requiredFields === REQUIRED_FIELDS.length;
}

/** Trim a page's forms down to what is worth keeping for diagnosis. */
function summariseForms(forms) {
  return (forms || []).map((form) => ({
    name: form.name,
    action: form.action,
    loose: !!form.loose,
    inputs: (form.inputs || []).map((i) => `${i.name}:${i.type}`),
    selects: (form.selects || []).map((sel) => ({
      name: sel.name,
      count: (sel.options || []).length,
      sample: (sel.options || []).slice(0, 8).map((o) => `${o.value}=${o.text}`),
    })),
  }));
}

/**
 * Find the calendar row a block has to change.
 *
 * cal_id is per person per day, so a block is matched on its person's S4 user
 * id and its first date. A block covering several days goes to the row for the
 * first of them; the form's own date range carries it across the rest.
 */
function resolveRow(payload, mapping, index) {
  const uid = (mapping.staffValues || {})[payload.tech_id];
  if (!uid) {
    return { error: `no S4 user id for ${payload.tech_id} — they were not in any staff list` };
  }
  const from = S4Mapping.splitDate(payload.start_date);
  if (!from) return { error: `could not read the date ${payload.start_date}` };
  const cell = index[`${uid}|${from.iso}`];
  if (!cell) {
    return {
      error: `no calendar row in the grid for ${payload.tech_id} (${uid}) on ${payload.start_date}`,
    };
  }
  // A cell with no id would open a blank editor, and posting that tells S4
  // nothing about which row to change.
  if (!/^\d+$/.test(String(cell.cal_id || "").trim()) || Number(cell.cal_id) === 0) {
    return {
      error:
        `no calendar row in the grid for ${payload.tech_id} (${uid}) on ${payload.start_date} ` +
        `— its cell carries no row id ("${cell.cal_id || ""}")`,
    };
  }
  return { uid, cell };
}

/** The form in an editor page that actually changes a shift. */
function editorForm(forms) {
  return (
    (forms || []).find((f) => (f.inputs || []).some((i) => i.name === "cal_id")) ||
    (forms || []).find((f) => /chkshift/.test(f.action || "")) ||
    (forms || [])[0] ||
    null
  );
}

/** Why a body must not be posted, or null if it is fine. */
function checkBody(payload, body, rowMapping, row, opened) {
  if (opened && !String(body.cal_id || "").trim()) {
    return "the editor for this row came back without a cal_id";
  }
  if (!(rowMapping.categoryValues || {})[payload.category]) {
    return `S4 offers no category matching ${payload.category}`;
  }
  if (payload.slot_id && !(rowMapping.shiftTimeValues || {})[payload.slot_id]) {
    return `S4 offers no shift time matching ${payload.shift_time}`;
  }
  // The editor renders the user it was opened for. If that is not the person
  // this block is about, the cell lookup went wrong and nothing should move.
  const staffField = (rowMapping.fields || {}).staff;
  const rendered = staffField ? (rowMapping.baseFields || {})[staffField] : "";
  if (opened && rendered && String(rendered) !== String(row.uid)) {
    return `the editor opened is for user ${rendered}, not ${payload.tech_id} (${row.uid})`;
  }
  return null;
}

/**
 * Everything one block needs before it can be posted: the calendar row it
 * changes, that row's editor as S4 renders it, and a body built from that.
 *
 * Each row's editor is read fresh because the hidden fields — cal_id first
 * among them — belong to that row and no other.
 */
async function prepareRow(payload, mapping, ctx, openEditor) {
  const row = resolveRow(payload, mapping, ctx.index);
  if (row.error) return { ok: false, skipped: true, detail: row.error };

  const url = new URL(S4Mapping.editorUrl(row.cell, ctx.signature), ctx.base).href;
  // Unopened rows only ever reach a dry run's table. Show them with their own
  // row's id rather than whichever row the probe happened to open.
  let rowMapping = Object.assign({}, mapping, {
    baseFields: Object.assign({}, mapping.baseFields, { cal_id: row.cell.cal_id }),
  });
  let action = mapping.action || "";
  if (openEditor) {
    let reply;
    try {
      reply = await ask({ type: "probeUrl", url });
    } catch (error) {
      return { ok: false, detail: `could not open this row's editor: ${error.message}`, editor: url };
    }
    if (!reply || !reply.ok) {
      const why = reply ? reply.detail || `HTTP ${reply.status}` : "no reply";
      return { ok: false, detail: `could not open this row's editor (${why})`, editor: url };
    }
    const form = editorForm(reply.forms);
    if (!form) return { ok: false, detail: "this row's editor came back with no form", editor: url };
    const matched = S4Mapping.matchOptions([form], ctx.plan);
    rowMapping = Object.assign({}, mapping, {
      baseFields: S4Mapping.baseFieldsOf([form], form.name),
      // This row's own editor is the authority on what it will accept.
      shiftTimeValues: Object.assign({}, mapping.shiftTimeValues, matched.shiftTimeValues),
      categoryValues: Object.assign({}, mapping.categoryValues, matched.categoryValues),
    });
    action = form.action || action;
  }
  const body = S4Mapping.buildBody(payload, rowMapping);
  const problem = checkBody(payload, body, rowMapping, row, openEditor);
  return {
    ok: !problem,
    detail: problem || "",
    body,
    action,
    editor: url,
    calId: row.cell.cal_id,
    opened: openEditor,
  };
}

function coverage(plan, mapping, grid) {
  const { index, duplicates } = S4Mapping.indexCells(
    (grid && grid.cells) || [],
    plan && plan.team_id
  );
  const payloads = payloadsFrom(plan);
  let resolved = 0;
  const examples = [];
  payloads.forEach((payload) => {
    const row = resolveRow(payload, mapping, index);
    if (row.cell) resolved += 1;
    else if (examples.length < 5) examples.push(row.error);
  });
  return {
    total: payloads.length,
    resolved,
    missing: payloads.length - resolved,
    duplicates,
    examples,
  };
}

function payloadsFrom(plan) {
  return (plan && plan.assignments) || [];
}

async function runPlan(dryRun) {
  await ready;
  if (state.run.running) throw new Error("A run is already going.");
  // The probe reads a dozen pages and takes a while. Starting a run in the
  // middle of it ran the whole month against no mapping at all.
  if (state.probing) {
    note("error", "Refused to run: still looking for the shift form");
    throw new Error("Still looking for the shift form — wait for that to finish.");
  }
  if (!state.plan) {
    note("error", "Refused to run: no plan loaded");
    throw new Error("Load a plan first.");
  }
  // A dry run sends nothing, so it must never be gated on the mapping — it is
  // the thing you reach for *because* the mapping is not working yet.
  if (!dryRun && !state.mapping) {
    note("error", "Refused to run: the shift form has not been found");
    throw new Error("Find the shift form first.");
  }
  if (!dryRun && !state.settings.allowWrites) {
    note("error", "Refused to run: writing to S4 is locked");
    throw new Error(
      "Writing to S4 is locked. Tick \u201cAllow writing to S4\u201d first — " +
        "dry runs work without it."
    );
  }

  const payloads = payloadsFrom(state.plan);
  const mapping = state.mapping || {
    fields: {},
    shiftTimeValues: {},
    categoryValues: {},
    staffValues: {},
  };
  const missing = S4Mapping.missingMapping(mapping, state.plan);
  if (!dryRun && (missing.fields.length || missing.slots.length || missing.categories.length)) {
    note("error", "Refused to run: the mapping is incomplete", missing);
    throw new Error(
      "Refusing to post with an incomplete mapping — " +
        [
          missing.fields.length ? `fields: ${missing.fields.join(", ")}` : "",
          missing.slots.length ? `shift times: ${missing.slots.join(", ")}` : "",
          missing.categories.length ? `categories: ${missing.categories.join(", ")}` : "",
        ]
          .filter(Boolean)
          .join("; ")
    );
  }

  // cal_id is per person per day, and the grid is the only place it comes
  // from. Without the grid's rows there is no block that can be posted safely.
  const cells = (state.grid && state.grid.cells) || [];
  if (!dryRun && !cells.length) {
    note("error", "Refused to run: the grid's calendar rows have not been read", {
      why: "each block needs the cal_id of its own row, and those come from the grid",
    });
    throw new Error(
      "Refusing to post: the month grid's calendar rows have not been read, so no block " +
        "has a cal_id to change. Open the month in S4 and press Find the shift form again."
    );
  }

  stopRequested = false;
  note(dryRun ? "info" : "warn", dryRun ? "Dry run started" : "Live run started — writing to S4", {
    blocks: payloads.length,
    month: state.plan.month,
    mapped: !!state.mapping,
  });
  state.run = {
    running: true,
    dryRun,
    index: 0,
    total: payloads.length,
    results: [],
    startedAt: new Date().toISOString(),
    finishedAt: null,
    stopped: false,
    note: "",
    current: null,
  };
  await save();

  let failures = 0;
  const { index } = S4Mapping.indexCells(cells, state.plan.team_id);
  const base = mapping.tabUrl ? `${new URL(mapping.tabUrl).origin}/` : "https://s4.inhouse.net/";
  const ctx = {
    index,
    signature: state.grid ? state.grid.signature : null,
    base,
    plan: state.plan,
  };
  // A dry run opens a handful of real editors — reading is harmless — so the
  // bodies it shows are the ones S4 would actually get.
  const DRY_OPEN = 5;
  let dryOpened = 0;
  // Worth saying once, rather than on all five hundred rows.
  const unmapped = !state.mapping;
  if (dryRun && unmapped) {
    note("warn", "Dry run has no field mapping — showing the plan only", {
      blocks: payloads.length,
      next: "Find the shift form, then dry run again",
    });
  } else if (dryRun && !cells.length) {
    note("warn", "Dry run has no calendar rows — no block can be matched to a row", {
      blocks: payloads.length,
      next: "Open the month in S4, press Find the shift form again, then dry run",
    });
  }

  // Anything thrown in here used to leave running stuck on, which greys out
  // every button with no way back except clearing the results.
  try {
  for (let i = 0; i < payloads.length; i += 1) {
    if (stopRequested) {
      state.run.stopped = true;
      state.run.note = `Stopped after ${i} of ${payloads.length}.`;
      break;
    }
    const payload = payloads[i];
    state.run.current = {
      tech: payload.tech_id,
      from: payload.start_date,
      to: payload.end_date,
      shift: payload.shift_time,
    };
    let result;
    if (dryRun && unmapped) {
      result = {
        ok: false,
        detail: "no field mapping yet, so nothing could be built",
        body: S4Mapping.buildBody(payload, mapping),
      };
    } else if (dryRun) {
      const open = dryOpened < DRY_OPEN && !!resolveRow(payload, mapping, index).cell;
      if (open) dryOpened += 1;
      const prepared = await prepareRow(payload, mapping, ctx, open);
      result = {
        ok: prepared.ok,
        skipped: prepared.skipped,
        detail: prepared.ok
          ? `dry run — row ${prepared.calId} ${prepared.opened ? "opened" : "found"}, nothing sent`
          : prepared.detail,
        body: prepared.body,
      };
    } else {
      const prepared = await prepareRow(payload, mapping, ctx, true);
      if (prepared.skipped) {
        result = { ok: false, skipped: true, detail: `skipped — ${prepared.detail}` };
      } else if (!prepared.ok) {
        result = { ok: false, detail: prepared.detail, body: prepared.body };
      } else {
        try {
          result = await ask({ type: "post", body: prepared.body, action: prepared.action });
        } catch (error) {
          result = { ok: false, detail: error.message };
        }
        result.body = prepared.body;
      }
    }
    // A row with no calendar row to change is left alone, not failed: nothing
    // was attempted, so it says nothing about whether S4 is accepting posts.
    if (!result.ok && !result.skipped) failures += 1;

    state.run.results.push({
      tech: payload.tech_id,
      slot: payload.slot_id,
      shift: payload.shift_time,
      from: payload.start_date,
      to: payload.end_date,
      days: payload.days,
      why: payload.source || "",
      ok: !!result.ok,
      skipped: !!result.skipped,
      detail: result.detail || "",
      body: result.body,
    });
    state.run.index = i + 1;
    if (result.skipped && !dryRun) {
      note("warn", `Skipped: ${payload.tech_id} ${payload.start_date}→${payload.end_date}`, {
        shift: payload.shift_time,
        detail: result.detail,
      });
    } else if (!result.ok && !result.skipped && !(dryRun && unmapped)) {
      note("error", `Refused: ${payload.tech_id} ${payload.start_date}→${payload.end_date}`, {
        shift: payload.shift_time,
        detail: result.detail,
      });
    } else if (!dryRun && (i < 3 || (i + 1) % 50 === 0 || i === payloads.length - 1)) {
      // Every row is in the results table; the log keeps the shape of the run
      // without 534 near-identical lines burying the failures.
      note("ok", `Posted ${i + 1} of ${payloads.length}`, {
        tech: payload.tech_id,
        from: payload.start_date,
        to: payload.end_date,
      });
    }
    await save();

    if (!dryRun && failures >= (state.settings.stopAfterFailures || 3)) {
      state.run.stopped = true;
      state.run.note =
        `Stopped after ${failures} failures — something is wrong with the mapping ` +
        `or the session. Nothing further was sent.`;
      break;
    }
    if (!dryRun && state.settings.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, state.settings.delayMs));
    }
  }
  } finally {
    const ok = state.run.results.filter((r) => r.ok).length;
    note(
      state.run.results.length && ok === state.run.results.length ? "ok" : "warn",
      dryRun ? "Dry run finished" : "Live run finished",
      {
        done: state.run.index,
        of: state.run.total,
        accepted: ok,
        refused: state.run.results.filter((r) => !r.ok && !r.skipped).length,
        skipped: state.run.results.filter((r) => r.skipped).length,
        stopped: state.run.stopped || false,
      }
    );
    state.run.current = null;
    state.run.running = false;
    state.run.finishedAt = new Date().toISOString();
    await save();
  }
  return state.run;
}

const handlers = {
  async getState() {
    await ready;
    return state;
  },

  async setPlan({ plan }) {
    await ready;
    if (!plan || !Array.isArray(plan.assignments)) {
      throw new Error("That file does not look like a plan — no 'assignments' array.");
    }
    state.plan = plan;
    state.run = JSON.parse(JSON.stringify(DEFAULT_STATE.run));
    // A mapping read against a different plan (or a previous install) is
    // misleading rather than useful — the panel showed one with no log behind
    // it, which read as if a probe had just run.
    if (state.mapping && state.mapping.forPlanMonth !== plan.month) {
      state.mapping = null;
      // The rows belong to that month's grid too.
      state.grid = null;
      note("info", "Cleared a mapping from an earlier session");
    } else if (state.mapping && state.grid) {
      // Same month, new blocks: say how many of these find a row.
      state.mapping.coverage = coverage(plan, state.mapping, state.grid);
    }
    note("ok", "Plan loaded", {
      month: plan.month,
      blocks: plan.assignments.length,
      techs: new Set(plan.assignments.map((a) => a.tech_id)).size,
      shortfalls: ((plan.issues || {}).shortfalls || []).length,
    });
    await save();
    return state;
  },

  async probe() {
    await ready;
    if (!state.plan) throw new Error("Load a plan first — the labels in it drive the matching.");
    if (state.probing) throw new Error("Already looking — give it a moment.");
    state.probing = true;
    await save();
    note("info", "Looking for the shift form");

    try {
      const plan = state.plan;
      const tabs = await s4Tabs();
      const looked = [];
      const pages = [];
      let host = null;
      let candidates = [];
      let gridSamples = [];

      // Every cell the grid offers, keyed later by person and day.
      const grid = { signature: null, cells: [], sources: [], calls: [] };
      const takeGrid = (url, found) => {
        if (!found) return;
        if (!grid.signature && found.signature) grid.signature = found.signature;
        if (found.cells && found.cells.length) {
          grid.cells = grid.cells.concat(found.cells);
          grid.sources.push({ url, cells: found.cells.length });
        }
        (found.calls || []).forEach((call) => {
          if (grid.calls.length < 3) grid.calls.push(call);
        });
      };

      const consider = (url, forms, fetched, facts) => {
        const read = readPage(forms, plan);
        const about = facts || {};
        const entry = {
          url,
          fetched: !!fetched,
          requiredFields: read.requiredFields,
          shiftTimes: read.shiftTimes,
          categories: read.categories,
          staff: read.staff,
          title: about.title || "",
          // A password box on a page that offers nothing else is the login
          // form, not a shift page that happens to carry one.
          login:
            !!about.login &&
            !(read.requiredFields || read.shiftTimes || read.categories || read.staff),
          snippet: about.snippet || "",
        };
        if (about.finalUrl && about.finalUrl !== url) entry.answeredFrom = about.finalUrl;
        looked.push(entry);
        pages.push({ url, read, forms });
        note("info", fetched ? "Read a linked S4 page" : "Read an open S4 tab", {
          url,
          requiredFields: `${read.requiredFields}/${REQUIRED_FIELDS.length}`,
          shiftTimes: read.shiftTimes,
          categories: read.categories,
          staff: read.staff,
        });
        if (entry.login) {
          note("warn", "S4 answered with its login page", {
            url,
            answeredFrom: entry.answeredFrom || url,
          });
        }
        return read;
      };

      for (const tab of tabs) {
        let reply;
        try {
          reply = await askTab(tab.id, { type: "probe" });
        } catch (error) {
          looked.push({ url: tab.url, note: "could not be read — reload it" });
          note("warn", "Could not read an open S4 tab", { url: tab.url, error: error.message });
          continue;
        }
        consider(tab.url, reply.forms, false, reply.page);
        takeGrid(tab.url, reply.grid);
        if (!host) host = tab;
        if (reply.candidates && reply.candidates.length) {
          candidates = candidates.concat(reply.candidates);
        }
        // Pin real calendar ids onto any bare "...&cal_id=" prefix: without
        // one, S4 serves the form with its Category dropdown empty.
        if (reply.gridSamples && reply.gridSamples.length) {
          gridSamples = gridSamples.concat(reply.gridSamples);
        }
        const ids = reply.calendarIds || [];
        if (ids.length) {
          const bare = (reply.candidates || []).filter((url) => /cal_id=$/.test(url));
          bare.forEach((prefix) => {
            ids.forEach((id) => candidates.push(prefix + id));
          });
          note("info", "Found calendar row ids in the grid", { ids, applied: bare.length });
        }
      }

      const manual = (state.settings.editUrl || "").trim();
      const origin = host ? new URL(host.url).origin : "https://s4.inhouse.net";
      const built = constructedCandidates(plan, origin);
      const seen = new Set(pages.map((entry) => entry.url));
      const toRead = [].concat(manual ? [manual] : [], built, candidates).filter((url) => {
        if (!url || seen.has(url)) return false;
        seen.add(url);
        return true;
      });

      if (host) {
        for (const url of toRead.slice(0, 14)) {
          let reply;
          try {
            reply = await askTab(host.id, { type: "probeUrl", url });
          } catch (error) {
            looked.push({ url, note: "could not be fetched" });
            continue;
          }
          if (!reply.ok) {
            looked.push({ url, note: reply.detail || `HTTP ${reply.status}` });
            note("warn", "Could not fetch a linked page", {
              url,
              detail: reply.detail || `HTTP ${reply.status}`,
            });
            continue;
          }
          consider(url, reply.forms, true, reply);
          takeGrid(url, reply.grid);
        }
      }

      // The same cell can turn up on several pages; keep one per cal_id.
      const byId = new Map();
      grid.cells.forEach((cell) => {
        const key = cell.cal_id || `${cell.user}|${cell.date}`;
        if (!byId.has(key)) byId.set(key, cell);
      });
      grid.cells = [...byId.values()];
      note(grid.cells.length ? "ok" : "warn", "Read the grid's calendar rows", {
        cells: grid.cells.length,
        popupFound: !!grid.signature,
        sources: grid.sources.map((src) => `${src.url} (${src.cells})`),
      });

      // Open one real cell's editor. Read with a bare cal_id, S4 renders the
      // editor blank — no categories, no shift times, no row ids. Read against a
      // real row, it renders the form it actually expects back.
      if (host && grid.cells.length) {
        // A row that really exists, in the plan's month, on this team if the
        // plan says which.
        const real = grid.cells.filter(
          (cell) => /^\d+$/.test(String(cell.cal_id || "")) && Number(cell.cal_id) > 0
        );
        const inMonth = real.filter((cell) =>
          (S4Mapping.normaliseDate(cell.date) || "").startsWith(plan.month)
        );
        const sampleCell =
          inMonth.find((cell) => String(cell.team) === String(plan.team_id)) ||
          inMonth[0] ||
          real[0] ||
          grid.cells[0];
        const url = new URL(
          S4Mapping.editorUrl(sampleCell, grid.signature),
          `${new URL(host.url).origin}/`
        ).href;
        try {
          const reply = await askTab(host.id, { type: "probeUrl", url });
          if (reply.ok) {
            consider(url, reply.forms, true, reply);
            note("ok", "Opened a real shift in the editor", {
              url,
              cal_id: sampleCell.cal_id,
              date: sampleCell.date,
            });
          } else {
            note("warn", "Could not open a real shift in the editor", {
              url,
              detail: reply.detail || `HTTP ${reply.status}`,
            });
          }
        } catch (error) {
          note("warn", "Could not open a real shift in the editor", { url, error: error.message });
        }
      }

      // Kept whatever happens next, so a probe that finds nothing still leaves
      // behind what it saw. Without this a failed probe left diagnostics empty.
      state.lastProbe = {
        at: new Date().toISOString(),
        looked,
        grid: {
          cells: grid.cells.length,
          popupFound: !!grid.signature,
          sources: grid.sources,
          calls: grid.calls,
          sampleCells: grid.cells.slice(0, 6),
        },
        pages: pages.map((entry) => ({ url: entry.url, forms: summariseForms(entry.forms) })),
      };

      if (!pages.length) {
        throw new Error(
          "None of the open S4 tabs could be read. Reload the S4 page so the extension " +
            "loads into it, then try again."
        );
      }

      const anything = pages.some(
        (entry) =>
          entry.read.requiredFields ||
          entry.read.shiftTimes ||
          entry.read.categories ||
          entry.read.staff
      );
      // Every page coming back as the login form means the session ran out,
      // not that S4 changed. Say that, rather than sending somebody hunting
      // for an editor window.
      const logins = looked.filter((entry) => entry.login).length;
      if (!anything && logins && logins >= looked.filter((e) => e.fetched).length / 2) {
        note("error", "S4 has logged this browser out", { loginPages: logins });
        throw new Error(
          `S4 answered ${logins} of the pages with its login page, so this browser's S4 ` +
            "session has run out. Reload the S4 tab, log in again, then press Find the " +
            "shift form."
        );
      }
      if (!anything) {
        throw new Error(
          `Looked at ${pages.length} S4 page(s) and found no shift form. Open the shift ` +
            "edit window — the one with Category, Shift Time and Duration on it — or paste " +
            "its address into the editor page box, then try again. Copy diagnostics " +
            "shows what each page contained."
        );
      }

      // Pick the page that supplies the most of what a post needs — that is the
      // form we submit to, and where the field names come from.
      let chosen = null;
      pages.forEach((entry) => {
        const candidate = Object.assign({}, entry.read, { url: entry.url, forms: entry.forms });
        chosen = betterPage(chosen, candidate);
      });

      // The option values — staff ids, shift-time ids, category codes — are
      // S4's own database ids and mean the same thing on every page, so they
      // are taken from wherever they turned up. S4 spreads them about: the
      // shift times live on the timings page, the staff list on another.
      const shiftTimeValues = {};
      const categoryValues = {};
      const staffValues = {};
      const contributed = {};
      // The page we post to speaks first: its option values are the ones the
      // form will actually accept, and they need not match the timings page.
      const ordered = pages
        .filter((entry) => entry.url === chosen.url)
        .concat(pages.filter((entry) => entry.url !== chosen.url));
      ordered.forEach((entry) => {
        const from = entry.url;
        const add = (target, source, label) => {
          Object.entries(source).forEach(([key, value]) => {
            if (target[key] === undefined) {
              target[key] = value;
              contributed[label] = contributed[label] || {};
              contributed[label][from] = (contributed[label][from] || 0) + 1;
            }
          });
        };
        add(shiftTimeValues, entry.read.matched.shiftTimeValues, "shiftTimes");
        add(categoryValues, entry.read.matched.categoryValues, "categories");
        add(staffValues, entry.read.matched.staffValues, "staff");
      });

      // Field names come from the page we post to, but fall back to another
      // page's name for anything it does not carry — a dropdown that only
      // appears on the timings page still has to be named in the body.
      const fields = Object.assign({}, chosen.fields);
      const borrowed = {};
      pages.forEach((entry) => {
        if (entry.url === chosen.url) return;
        REQUIRED_FIELDS.concat(["reason", "log"]).forEach((name) => {
          if (!fields[name] && entry.read.fields[name]) {
            fields[name] = entry.read.fields[name];
            borrowed[name] = entry.url;
          }
        });
      });

      const target =
        (chosen.forms || []).find((f) => f.name === (plan.form_name || "shift")) ||
        (chosen.forms || [])[0];

      state.mapping = {
        fields,
        borrowedFields: borrowed,
        baseFields: S4Mapping.baseFieldsOf(chosen.forms, plan.form_name || "shift"),
        shiftTimeValues,
        categoryValues,
        staffValues,
        unmatched: chosen.matched.unmatched,
        constantFields: state.mapping ? state.mapping.constantFields || {} : {},
        action: target ? target.action : "",
        probedAt: new Date().toISOString(),
        forPlanMonth: plan.month,
        tabId: host ? host.id : null,
        tabUrl: chosen.url,
        looked,
        contributed,
        gridSamples: gridSamples.slice(0, 8),
        forms: chosen.forms,
        // Every page, so a mismatch can be read rather than guessed at.
        pages: pages.map((entry) => ({
          url: entry.url,
          requiredFields: entry.read.requiredFields,
          shiftTimes: entry.read.shiftTimes,
          categories: entry.read.categories,
          staff: entry.read.staff,
          fields: entry.read.fields,
          forms: summariseForms(entry.forms),
        })),
      };

      state.grid = {
        signature: grid.signature,
        cells: grid.cells,
        sources: grid.sources,
        calls: grid.calls,
        readAt: new Date().toISOString(),
      };
      state.mapping.gridCells = state.grid.cells.length;
      state.mapping.coverage = coverage(plan, state.mapping, state.grid);
      note(
        state.mapping.coverage.missing ? "warn" : "ok",
        "Matched plan blocks to calendar rows",
        {
          resolved: state.mapping.coverage.resolved,
          of: state.mapping.coverage.total,
          missing: state.mapping.coverage.missing,
          examples: state.mapping.coverage.examples,
        }
      );

      const shortfall = S4Mapping.missingMapping(state.mapping, plan);
      const incomplete =
        shortfall.fields.length || shortfall.slots.length || shortfall.categories.length;
      note(incomplete ? "warn" : "ok", "Mapping built", {
        postingTo: chosen.url,
        requiredFields: `${chosen.requiredFields}/${REQUIRED_FIELDS.length}`,
        shiftTimes: Object.keys(shiftTimeValues).length,
        categories: Object.keys(categoryValues).length,
        staff: Object.keys(staffValues).length,
        pagesRead: pages.length,
        borrowedFields: Object.keys(borrowed),
        missingFields: shortfall.fields,
        missingShiftTimes: shortfall.slots,
        missingCategories: shortfall.categories,
      });
      return state;
    } finally {
      state.probing = false;
      await save();
    }
  },

  async startRun({ dryRun }) {
    return runPlan(!!dryRun);
  },

  async stopRun() {
    stopRequested = true;
    return { ok: true };
  },

  /** Let the UI clear a run that is flagged as going but plainly is not. */
  async unstick() {
    await ready;
    stopRequested = true;
    state.run.running = false;
    state.run.current = null;
    state.run.note = "Run state cleared by hand.";
    note("warn", "Run state cleared by hand");
    await save();
    return state;
  },

  async reset() {
    await ready;
    state.run = JSON.parse(JSON.stringify(DEFAULT_STATE.run));
    await save();
    return state;
  },

  async clearLog() {
    await ready;
    state.log = [];
    note("info", "Log cleared");
    await save();
    return state;
  },

  /** Everything worth sending to somebody who has to work out what went wrong. */
  async diagnostics() {
    await ready;
    const plan = state.plan;
    const mapping = state.mapping;
    return {
      takenAt: new Date().toISOString(),
      version: browser.runtime.getManifest().version,
      plan: plan && {
        month: plan.month,
        generated: plan.generated,
        blocks: plan.assignments.length,
        techs: plan.techs ? plan.techs.length : null,
        slots: plan.slots ? plan.slots.length : null,
        issues: plan.issues || null,
        sample: plan.assignments.slice(0, 3),
      },
      mapping: mapping && {
        probedAt: mapping.probedAt,
        foundOn: mapping.tabUrl,
        action: mapping.action,
        fields: mapping.fields,
        shiftTimeValues: mapping.shiftTimeValues,
        categoryValues: mapping.categoryValues,
        staffCount: Object.keys(mapping.staffValues || {}).length,
        unmatched: mapping.unmatched,
        looked: mapping.looked,
        contributed: mapping.contributed,
        borrowedFields: mapping.borrowedFields,
        baseFields: mapping.baseFields,
        gridSamples: mapping.gridSamples,
        coverage: mapping.coverage,
        grid: state.grid
          ? {
              cells: state.grid.cells.length,
              sources: state.grid.sources,
              popup: state.grid.signature
                ? { params: state.grid.signature.params, source: state.grid.signature.source }
                : null,
              calls: state.grid.calls,
              // Enough of one person's month to see whether each day is its
              // own row or one row spans several.
              sampleCells: state.grid.cells.slice(0, 6),
              distinctRowIds: new Set(state.grid.cells.map((c) => c.cal_id)).size,
              cellsSpanningDays: state.grid.cells.filter(
                (c) => c.start_date && c.end_date && c.start_date !== c.end_date
              ).length,
            }
          : null,
        // Exactly what one post would carry, which is the thing to check
        // before anything is written.
        sampleBody:
          plan && plan.assignments && plan.assignments.length
            ? S4Mapping.buildBody(plan.assignments[0], mapping)
            : null,
        // The first rows of the last run as built — after a dry run these
        // are real editors read for real rows, cal_id and all.
        firstBodies: state.run.results.slice(0, 3).map((r) => ({
          tech: r.tech,
          from: r.from,
          to: r.to,
          ok: r.ok,
          detail: r.detail,
          body: r.body,
        })),
        // Every page read, with the raw field names and dropdown options of
        // each. A mismatch always comes down to these, and S4 spreads the
        // pieces over several pages, so one page's worth is not enough.
        pages: mapping.pages,
      },
      // What the last probe saw, when it is newer than the mapping — a probe
      // that fails leaves no mapping, and this is all there is to go on.
      lastProbe:
        state.lastProbe && (!mapping || state.lastProbe.at > mapping.probedAt)
          ? state.lastProbe
          : null,
      missing: plan && mapping ? S4Mapping.missingMapping(mapping, plan) : null,
      settings: state.settings,
      run: {
        running: state.run.running,
        dryRun: state.run.dryRun,
        index: state.run.index,
        total: state.run.total,
        stopped: state.run.stopped,
        note: state.run.note,
        failures: state.run.results.filter((r) => !r.ok).slice(0, 25),
      },
      log: state.log || [],
    };
  },

  async setSettings({ settings }) {
    await ready;
    const before = state.settings.allowWrites;
    state.settings = Object.assign({}, state.settings, settings);
    if (before !== state.settings.allowWrites) {
      note("warn", state.settings.allowWrites
        ? "Writing to S4 was unlocked"
        : "Writing to S4 was locked again");
    }
    await save();
    return state;
  },
};

browser.runtime.onMessage.addListener((message) => {
  const handler = handlers[message && message.type];
  if (!handler) return undefined;
  return handler(message).catch((error) => ({ error: error.message }));
});
