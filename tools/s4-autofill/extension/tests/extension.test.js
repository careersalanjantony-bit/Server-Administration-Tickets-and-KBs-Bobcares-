"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { load, samplePlan } = require("./harness.js");

const TECHS = ["mojin.t", "alan.j"];

async function ready(options = {}) {
  const harness = load(Object.assign({ techIds: TECHS }, options));
  await harness.send("setPlan", { plan: options.plan || samplePlan() });
  await harness.send("setSettings", {
    settings: { delayMs: 0, allowWrites: options.allowWrites !== false },
  });
  const state = await harness.send("probe");
  return { harness, state };
}

// ------------------------------------------------------------------ mapping

test("probe matches every shift time, category and tech", async () => {
  const { state } = await ready();
  assert.strictEqual(Object.keys(state.mapping.shiftTimeValues).length, 15);
  assert.strictEqual(state.mapping.categoryValues.W, "W");
  assert.deepStrictEqual(state.mapping.staffValues, { "mojin.t": "200", "alan.j": "201" });
});

test("probe finds all twelve form fields", async () => {
  const { state } = await ready();
  const expected = [
    "staff", "category", "start_date", "end_date", "shift_time", "time_hour",
    "time_minute", "time_meridiem", "duration_hours", "duration_minutes", "reason", "log",
  ];
  expected.forEach((field) => assert.ok(state.mapping.fields[field], `missing ${field}`));
});

test("duration fields are not mistaken for the clock fields", async () => {
  const { state } = await ready();
  const { fields } = state.mapping;
  assert.strictEqual(fields.duration_hours, "dur_hr");
  assert.strictEqual(fields.time_hour, "stime_hr");
  assert.notStrictEqual(fields.duration_hours, fields.time_hour);
  assert.notStrictEqual(fields.duration_minutes, fields.time_minute);
});

test("a password field's value never leaves the page", async () => {
  const { state } = await ready();
  const inputs = state.mapping.forms[0].inputs;
  const password = inputs.find((i) => i.type === "password");
  assert.ok(password, "the fixture has a password field");
  assert.strictEqual(password.value, "");
});

test("leading zeros in a shift label do not break the match", async () => {
  const { harness } = await ready();
  const key = harness.S4Mapping.timeKey;
  assert.strictEqual(key("7:00am-3:00pm"), key("07:00am-03:00pm"));
});

// ------------------------------------------------------------------ bodies

test("the posted body carries S4's own option values", async () => {
  const { harness } = await ready();
  await harness.send("startRun", { dryRun: false });
  const [first] = harness.posted;
  assert.strictEqual(first.body.staff, "200");
  assert.strictEqual(first.body.shift_time, "1");
  assert.strictEqual(first.body.sdate, "01-Oct-2026");
  assert.strictEqual(first.body.edate, "03-Oct-2026");
});

test("the clock is split the way S4's widgets expect", async () => {
  const { harness } = await ready();
  await harness.send("startRun", { dryRun: false });
  assert.strictEqual(harness.posted[0].body.stime_hr, "6");
  assert.strictEqual(harness.posted[0].body.stime_min, "58");
  assert.strictEqual(harness.posted[0].body.stime_ampm, "am");
  assert.strictEqual(harness.posted[1].body.stime_hr, "2");
  assert.strictEqual(harness.posted[1].body.stime_ampm, "pm");
  assert.strictEqual(harness.posted[0].body.dur_hr, "8");
  assert.strictEqual(harness.posted[0].body.dur_min, "00");
});

test("midnight and noon are not posted as hour zero", async () => {
  const { harness, state } = await ready();
  const build = (time) =>
    harness.S4Mapping.buildBody({ time, duration_min: 480, tech_id: "x", category: "W" }, state.mapping);
  assert.strictEqual(build("00:30").stime_hr, "12");
  assert.strictEqual(build("00:30").stime_ampm, "am");
  assert.strictEqual(build("12:30").stime_hr, "12");
  assert.strictEqual(build("12:30").stime_ampm, "pm");
});

// --------------------------------------------------------------- safety

test("a dry run sends nothing at all", async () => {
  const { harness } = await ready();
  const run = await harness.send("startRun", { dryRun: true });
  assert.strictEqual(harness.posted.length, 0);
  assert.strictEqual(run.results.length, 2);
  assert.ok(run.results.every((r) => r.ok));
  assert.match(run.results[0].detail, /dry run/);
});

test("a live run refuses to start when the mapping is incomplete", async () => {
  const harness = load({ techIds: TECHS, selects: false, editors: false });
  await harness.send("setPlan", { plan: samplePlan() });
  await harness.send("setSettings", { settings: { allowWrites: true } });
  await harness.send("probe");
  const reply = await harness.send("startRun", { dryRun: false });
  assert.ok(reply.error, "should refuse");
  assert.match(reply.error, /incomplete mapping/i);
  assert.strictEqual(harness.posted.length, 0);
});

test("a dry run is still allowed when the mapping is incomplete", async () => {
  const harness = load({ techIds: TECHS, selects: false });
  await harness.send("setPlan", { plan: samplePlan() });
  await harness.send("probe");
  const run = await harness.send("startRun", { dryRun: true });
  assert.ok(!run.error);
  assert.strictEqual(harness.posted.length, 0);
});

test("a run stops itself once failures pile up", async () => {
  const plan = samplePlan({
    assignments: Array.from({ length: 10 }, (_, i) => ({
      tech_id: "mojin.t", category: "W", slot_id: "s0",
      shift_time: "06:58am-02:58pm", start_date: `0${(i % 9) + 1}-Oct-2026`,
      end_date: `0${(i % 9) + 1}-Oct-2026`, days: 1, time: "06:58",
      duration_min: 480, reason: "x", source: "minimum",
    })),
  });
  const { harness } = await ready({
    plan,
    respond: () => ({ status: 200, text: "<html>Error: invalid staff</html>" }),
  });
  const run = await harness.send("startRun", { dryRun: false });
  assert.ok(run.stopped, "should stop");
  assert.ok(harness.posted.length <= 3, `stopped early, posted ${harness.posted.length}`);
  assert.match(run.note, /failures/);
});

test("an error page is reported as a failure, not a success", async () => {
  const { harness } = await ready({
    respond: () => ({ status: 200, text: "<html><body>Error: not allowed</body></html>" }),
  });
  const run = await harness.send("startRun", { dryRun: false });
  assert.ok(!run.results[0].ok);
  assert.match(run.results[0].detail, /not allowed/i);
});

test("an HTTP error is reported as a failure", async () => {
  const { harness } = await ready({ respond: () => ({ status: 500, text: "boom" }) });
  const run = await harness.send("startRun", { dryRun: false });
  assert.ok(!run.results[0].ok);
  assert.match(run.results[0].detail, /500/);
});

test("a plain success page is reported as ok", async () => {
  const { harness } = await ready();
  const run = await harness.send("startRun", { dryRun: false });
  assert.ok(run.results.every((r) => r.ok), JSON.stringify(run.results, null, 2));
});

test("stopping mid-run leaves the rest unsent", async () => {
  const plan = samplePlan({
    assignments: Array.from({ length: 20 }, (_, i) => ({
      tech_id: "mojin.t", category: "W", slot_id: "s0",
      shift_time: "06:58am-02:58pm", start_date: "01-Oct-2026",
      end_date: "01-Oct-2026", days: 1, time: "06:58", duration_min: 480,
      reason: "x", source: "minimum", seq: i,
    })),
  });
  const harness = load({ techIds: TECHS });
  await harness.send("setPlan", { plan });
  await harness.send("setSettings", { settings: { delayMs: 25, allowWrites: true } });
  await harness.send("probe");
  const running = harness.send("startRun", { dryRun: false });
  await new Promise((resolve) => setTimeout(resolve, 60));
  await harness.send("stopRun");
  const run = await running;
  assert.ok(run.stopped, "should record that it was stopped");
  assert.ok(harness.posted.length < 20, `stopped early, posted ${harness.posted.length}`);
  assert.match(run.note, /Stopped after/);
});

test("a file that is not a plan is rejected", async () => {
  const harness = load({ techIds: TECHS });
  const reply = await harness.send("setPlan", { plan: { hello: "world" } });
  assert.ok(reply.error);
  assert.match(reply.error, /assignments/);
});

test("probing before a plan is loaded is refused", async () => {
  const harness = load({ techIds: TECHS });
  const reply = await harness.send("probe");
  assert.ok(reply.error);
  assert.match(reply.error, /plan/i);
});

// ------------------------------------------------------------- reporting

test("results say which tech, which dates and why", async () => {
  const { harness } = await ready();
  const run = await harness.send("startRun", { dryRun: false });
  const [first] = run.results;
  assert.strictEqual(first.tech, "mojin.t");
  assert.strictEqual(first.from, "01-Oct-2026");
  assert.strictEqual(first.days, 3);
  assert.strictEqual(first.why, "preference");
});

test("progress is recorded as the run goes", async () => {
  const { harness } = await ready();
  const run = await harness.send("startRun", { dryRun: false });
  assert.strictEqual(run.index, run.total);
  assert.strictEqual(run.total, 2);
  assert.ok(run.finishedAt);
});

test("missingMapping names the slots it could not match", async () => {
  const { harness, state } = await ready();
  const plan = samplePlan();
  plan.assignments[0].slot_id = "ghost";
  const missing = harness.S4Mapping.missingMapping(state.mapping, plan);
  assert.deepStrictEqual([...missing.slots], ["ghost"]);
});

// --------------------------------------------- finding the form on S4's pages
// S4 splits this over two windows: the month grid carries an empty
// <form name="shift"> with the controls rendered elsewhere in the document,
// and the edit popup carries a normal form. Both have to work, and the person
// should not have to know which window to be on.

test("fields rendered outside the form element are still found", async () => {
  const harness = load({ techIds: TECHS, loose: true });
  await harness.send("setPlan", { plan: samplePlan() });
  const state = await harness.send("probe");
  assert.ok(!state.error, state.error);
  assert.strictEqual(Object.keys(state.mapping.shiftTimeValues).length, 15);
  assert.ok(state.mapping.fields.start_date, "start date should still be found");
});

test("an empty-form page still posts the same body", async () => {
  const loose = load({ techIds: TECHS, loose: true });
  await loose.send("setPlan", { plan: samplePlan() });
  await loose.send("setSettings", { settings: { delayMs: 0, allowWrites: true } });
  await loose.send("probe");
  await loose.send("startRun", { dryRun: false });

  const normal = load({ techIds: TECHS });
  await normal.send("setPlan", { plan: samplePlan() });
  await normal.send("setSettings", { settings: { delayMs: 0, allowWrites: true } });
  await normal.send("probe");
  await normal.send("startRun", { dryRun: false });

  assert.deepStrictEqual(loose.posted[0].body, normal.posted[0].body);
});

test("a password field outside the form is still not read", async () => {
  const harness = load({ techIds: TECHS, loose: true });
  await harness.send("setPlan", { plan: samplePlan() });
  const state = await harness.send("probe");
  const all = state.mapping.forms.flatMap((f) => f.inputs || []);
  const password = all.find((i) => i.type === "password");
  assert.ok(password, "the fixture has a password field");
  assert.strictEqual(password.value, "");
});

test("a page with no shift form at all says so plainly", async () => {
  const harness = load({ techIds: [], selects: false, noFields: true });
  await harness.send("setPlan", { plan: samplePlan() });
  const reply = await harness.send("probe");
  assert.ok(reply.error, "should refuse");
  assert.match(reply.error, /no shift form/i);
});

test("the probe records which tab it settled on", async () => {
  const { state } = await ready();
  assert.ok(state.mapping.tabId !== undefined);
  assert.ok(Array.isArray(state.mapping.looked));
  assert.ok(state.mapping.looked.length >= 1);
});

// ------------------------------------------------- guarding the wrong month

test("the month written comes from the dates, not the page being viewed", async () => {
  // The person may well be looking at a different month in S4. What lands is
  // decided by sdate/edate in each post, which must come from the plan.
  const { harness } = await ready();
  await harness.send("startRun", { dryRun: false });
  assert.ok(harness.posted.every((p) => /-Oct-2026$/.test(p.body.sdate)));
  assert.ok(harness.posted.every((p) => /-Oct-2026$/.test(p.body.edate)));
});

test("a plan carries its own coverage shortfalls", async () => {
  const plan = samplePlan({
    issues: { shortfalls: ["2026-12-06 e1500: need 2, got 1"], warnings: [] },
  });
  const harness = load({ techIds: TECHS });
  const state = await harness.send("setPlan", { plan });
  assert.deepStrictEqual(state.plan.issues.shortfalls.length, 1);
});

// ------------------------------------------------------------- the write lock
// Only one month is ever unlocked in S4, so a mis-click on the live button
// would land in a roster people are working to. Writing is off until asked for.

test("writing is locked by default", async () => {
  const harness = load({ techIds: TECHS });
  await harness.send("setPlan", { plan: samplePlan() });
  await harness.send("probe");
  const reply = await harness.send("startRun", { dryRun: false });
  assert.ok(reply.error, "should refuse");
  assert.match(reply.error, /locked/i);
  assert.strictEqual(harness.posted.length, 0);
});

test("a dry run works while writing is locked", async () => {
  const harness = load({ techIds: TECHS });
  await harness.send("setPlan", { plan: samplePlan() });
  await harness.send("probe");
  const run = await harness.send("startRun", { dryRun: true });
  assert.ok(!run.error, run.error);
  assert.strictEqual(run.results.length, 2);
  assert.strictEqual(harness.posted.length, 0);
});

test("unlocking lets a live run through", async () => {
  const harness = load({ techIds: TECHS });
  await harness.send("setPlan", { plan: samplePlan() });
  await harness.send("setSettings", { settings: { delayMs: 0, allowWrites: true } });
  await harness.send("probe");
  const run = await harness.send("startRun", { dryRun: false });
  assert.ok(!run.error, run.error);
  assert.strictEqual(harness.posted.length, 2);
});

test("the lock survives a reset of the run", async () => {
  const harness = load({ techIds: TECHS });
  await harness.send("setPlan", { plan: samplePlan() });
  await harness.send("probe");
  await harness.send("reset");
  const reply = await harness.send("startRun", { dryRun: false });
  assert.match(reply.error, /locked/i);
});

// ------------------------------------------------------------- the UI tab
// The UI used to be a browser_action popup. Firefox closes a popup as soon as
// it loses focus, and the file picker does exactly that — so the plan was lost
// mid-load every time. It lives in a tab now.

test("the plan survives being loaded", async () => {
  const harness = load({ techIds: TECHS });
  await harness.send("setPlan", { plan: samplePlan() });
  const state = await harness.send("getState");
  assert.ok(state.plan, "the plan should still be there on the next read");
  assert.strictEqual(state.plan.assignments.length, 2);
  assert.strictEqual(state.plan.month, "2026-10");
});

test("a loaded plan is kept across a fresh read of the state", async () => {
  const harness = load({ techIds: TECHS });
  await harness.send("setPlan", { plan: samplePlan() });
  await harness.send("probe");
  const first = await harness.send("getState");
  const second = await harness.send("getState");
  assert.strictEqual(second.plan.assignments.length, first.plan.assignments.length);
  assert.ok(second.mapping, "the mapping should persist too");
});

test("clicking the toolbar button opens the UI in a tab", async () => {
  const harness = load({ techIds: TECHS });
  assert.ok(typeof harness.bus.onAction === "function", "a click handler is registered");
  const before = harness.bus.tabs.length;
  await harness.bus.onAction();
  assert.strictEqual(harness.bus.tabs.length, before + 1);
  assert.match(harness.bus.tabs[before].url, /ui\/ui\.html$/);
});

test("clicking again focuses the open UI tab instead of opening another", async () => {
  const harness = load({ techIds: TECHS });
  await harness.bus.onAction();
  const after = harness.bus.tabs.length;
  await harness.bus.onAction();
  assert.strictEqual(harness.bus.tabs.length, after, "should not open a second tab");
});

test("the UI tab is never mistaken for the S4 page", async () => {
  // tabs.query is matched loosely in the harness, so the extension's own page
  // must be filtered out by url or the probe would try to talk to itself.
  const harness = load({
    techIds: TECHS,
    tabs: [
      { id: 9, url: "moz-extension://test/ui/ui.html" },
      { id: 1, url: "https://s4.inhouse.net/index.php?action=view_shift&t=6" },
    ],
  });
  await harness.send("setPlan", { plan: samplePlan() });
  const state = await harness.send("probe");
  assert.ok(!state.error, state.error);
  assert.strictEqual(state.mapping.tabId, 1, "should settle on the S4 tab");
});

// ------------------------------------------------------- wiring the manifest
// background.js called into S4Mapping while the manifest only loaded
// background.js, so the background page threw "S4Mapping is not defined" the
// moment anyone pressed Find the shift form. These check the wiring itself.

const fs = require("node:fs");
const path = require("node:path");

const EXT = path.join(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));

test("the background page loads the mapping helper it calls into", async () => {
  const harness = load({ techIds: TECHS });
  assert.ok(
    harness.backgroundGlobals.S4Mapping,
    "S4Mapping must exist in the background context, not just the content one"
  );
  assert.strictEqual(typeof harness.backgroundGlobals.S4Mapping.buildBody, "function");
});

test("every file the manifest names exists", () => {
  const named = [
    ...manifest.background.scripts,
    ...manifest.content_scripts.flatMap((entry) => entry.js),
    manifest.browser_action.default_icon,
    ...Object.values(manifest.icons || {}),
  ];
  named.forEach((relative) => {
    assert.ok(fs.existsSync(path.join(EXT, relative)), `manifest names a missing file: ${relative}`);
  });
});

test("the UI page loads every script it needs and they all exist", () => {
  const html = fs.readFileSync(path.join(EXT, "ui", "ui.html"), "utf8");
  const srcs = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(srcs.some((s) => s.endsWith("mapping.js")), "the UI calls S4Mapping too");
  srcs.forEach((src) => {
    assert.ok(
      fs.existsSync(path.join(EXT, "ui", src)),
      `ui.html references a missing script: ${src}`
    );
  });
  const hrefs = [...html.matchAll(/<link[^>]+href="([^"]+)"/g)].map((m) => m[1]);
  hrefs.forEach((href) => {
    assert.ok(
      fs.existsSync(path.join(EXT, "ui", href)),
      `ui.html references a missing stylesheet: ${href}`
    );
  });
});

test("the packaged xpi would carry every file the manifest names", () => {
  const build = fs.readFileSync(path.join(EXT, "build.sh"), "utf8");
  const packaged = ["manifest.json", "background.js", "content", "ui", "icons"];
  packaged.forEach((entry) => {
    assert.ok(build.includes(entry), `build.sh does not package ${entry}`);
  });
});

// ------------------------------------------- S4 keeps the editor on its own page
// The month grid holds a team switcher, an empty <form name="shift"> and two
// date boxes — no Category, no Shift Time, no Duration. Probing it found
// "2 fields · 0 shift times · 0 categories · 0 staff". The real editor opens in
// another window, so the extension has to go and read that page.

const { makeDocument } = require("./harness.js");

const EDITOR_URL =
  "https://s4.inhouse.net/index.php?action=view_shift&sdate=2026-10-01&edate=2026-10-31&t=6&edit_co_shift=N";

function gridHarness(extra = {}) {
  const editorDoc = makeDocument(TECHS, {});
  return load(
    Object.assign(
      {
        techIds: TECHS,
        grid: EDITOR_URL,
        pages: { [EDITOR_URL]: "EDITOR_HTML" },
        documents: { EDITOR_HTML: editorDoc },
      },
      extra
    )
  );
}

test("probing the month grid alone finds almost nothing", async () => {
  // Without following the link, and with no row's editor to open, this is
  // what the person saw.
  const harness = load({ techIds: TECHS, grid: EDITOR_URL, editors: false });
  await harness.send("setPlan", { plan: samplePlan() });
  const state = await harness.send("probe");
  const found = state.mapping ? Object.keys(state.mapping.shiftTimeValues).length : 0;
  assert.strictEqual(found, 0, "the grid has no shift times on it");
});

test("it follows the grid's own link to the editor and finds the form", async () => {
  const harness = gridHarness();
  await harness.send("setPlan", { plan: samplePlan() });
  const state = await harness.send("probe");
  assert.ok(!state.error, state.error);
  assert.strictEqual(Object.keys(state.mapping.shiftTimeValues).length, 15);
  assert.strictEqual(Object.keys(state.mapping.staffValues).length, 2);
  assert.ok(harness.fetched.includes(EDITOR_URL), "should have read the editor page");
});

test("the page it settled on is reported, not the tab that was open", async () => {
  const harness = gridHarness();
  await harness.send("setPlan", { plan: samplePlan() });
  const state = await harness.send("probe");
  assert.strictEqual(state.mapping.tabUrl, EDITOR_URL);
  assert.ok(state.mapping.looked.some((entry) => entry.fetched));
});

test("a pasted editor address is tried first", async () => {
  const harness = gridHarness({ grid: "https://s4.inhouse.net/index.php?action=nothing" });
  await harness.send("setPlan", { plan: samplePlan() });
  await harness.send("setSettings", { settings: { editUrl: EDITOR_URL } });
  const state = await harness.send("probe");
  assert.ok(!state.error, state.error);
  assert.strictEqual(Object.keys(state.mapping.shiftTimeValues).length, 15);
  assert.strictEqual(harness.fetched[0], EDITOR_URL, "the pasted url should be read first");
});

test("a full run against the grid posts to the editor's action", async () => {
  const harness = gridHarness();
  await harness.send("setPlan", { plan: samplePlan() });
  await harness.send("setSettings", { settings: { delayMs: 0, allowWrites: true } });
  await harness.send("probe");
  const run = await harness.send("startRun", { dryRun: false });
  assert.ok(!run.error, run.error);
  assert.strictEqual(harness.posted.length, 2);
  assert.strictEqual(harness.posted[0].body.shift_time, "1");
  assert.strictEqual(harness.posted[0].body.staff, "200");
});

test("a grid with no editor to find reports what is missing rather than erroring", async () => {
  // The grid still has a team switcher and two date boxes, so it is not
  // "nothing" — the honest outcome is an incomplete mapping listed in full,
  // which is what the person saw.
  const harness = load({
    techIds: TECHS,
    grid: "https://s4.inhouse.net/index.php?action=nothing",
    editors: false,
  });
  await harness.send("setPlan", { plan: samplePlan() });
  const state = await harness.send("probe");
  assert.ok(!state.error, "it found *something*, so it should report, not throw");
  const missing = harness.S4Mapping.missingMapping(state.mapping, samplePlan());
  assert.ok(missing.fields.length, "should name the fields it could not find");
  assert.ok(missing.slots.length, "should name the shift times it could not match");
});

test("a page with nothing on it at all names the fallback", async () => {
  const harness = load({ techIds: [], selects: false, noFields: true });
  await harness.send("setPlan", { plan: samplePlan() });
  const reply = await harness.send("probe");
  assert.ok(reply.error, "should refuse");
  assert.match(reply.error, /editor page/i);
});

test("an incomplete mapping still blocks a live run", async () => {
  const harness = load({
    techIds: TECHS,
    grid: "https://s4.inhouse.net/index.php?action=nothing",
    editors: false,
  });
  await harness.send("setPlan", { plan: samplePlan() });
  await harness.send("setSettings", { settings: { allowWrites: true } });
  await harness.send("probe");
  const reply = await harness.send("startRun", { dryRun: false });
  assert.match(reply.error, /incomplete mapping/i);
  assert.strictEqual(harness.posted.length, 0);
});

// ------------------------------------------------- the dry run must never jam
// A dry run sends nothing, so gating it behind a working mapping made the one
// diagnostic tool unusable exactly when it was needed. And a throw inside the
// run loop used to leave `running` set, grey­ing out every button for good.

test("a dry run works with no mapping at all", async () => {
  const harness = load({ techIds: TECHS });
  await harness.send("setPlan", { plan: samplePlan() });
  const run = await harness.send("startRun", { dryRun: true });
  assert.ok(!run.error, run.error);
  assert.strictEqual(run.results.length, 2);
  assert.strictEqual(harness.posted.length, 0);
});

test("a dry run with no mapping says why it could build nothing", async () => {
  const harness = load({ techIds: TECHS });
  await harness.send("setPlan", { plan: samplePlan() });
  const run = await harness.send("startRun", { dryRun: true });
  assert.match(run.results[0].detail, /no field mapping/i);
  assert.strictEqual(run.results[0].ok, false);
});

test("a dry run against a half-mapped page still lists every row", async () => {
  const harness = load({
    techIds: TECHS,
    grid: "https://s4.inhouse.net/index.php?action=nothing",
    editors: false,
  });
  await harness.send("setPlan", { plan: samplePlan() });
  await harness.send("probe");
  const run = await harness.send("startRun", { dryRun: true });
  assert.ok(!run.error, run.error);
  assert.strictEqual(run.results.length, 2);
  assert.strictEqual(harness.posted.length, 0);
});

test("a live run still needs the form to have been found", async () => {
  const harness = load({ techIds: TECHS });
  await harness.send("setPlan", { plan: samplePlan() });
  await harness.send("setSettings", { settings: { allowWrites: true } });
  const reply = await harness.send("startRun", { dryRun: false });
  assert.match(reply.error, /find the shift form/i);
  assert.strictEqual(harness.posted.length, 0);
});

test("a crash mid-run does not leave the buttons stuck", async () => {
  const harness = load({ techIds: TECHS });
  await harness.send("setPlan", { plan: samplePlan() });
  await harness.send("setSettings", { settings: { delayMs: 0, allowWrites: true } });
  await harness.send("probe");

  // Force a throw from inside the loop, where nothing used to catch it.
  const mapping = harness.backgroundGlobals.S4Mapping;
  const real = mapping.buildBody;
  mapping.buildBody = () => {
    throw new TypeError("boom");
  };
  const reply = await harness.send("startRun", { dryRun: false });
  mapping.buildBody = real;

  assert.ok(reply.error, "the failure should surface");
  const after = await harness.send("getState");
  assert.strictEqual(after.run.running, false, "running must always be cleared");

  // And the UI must be usable again straight away.
  const second = await harness.send("startRun", { dryRun: true });
  assert.ok(!second.error, `a later run should work: ${second.error}`);
});

test("the stuck-run state can be cleared by hand too", async () => {
  const harness = load({ techIds: TECHS });
  await harness.send("setPlan", { plan: samplePlan() });
  await harness.send("reset");
  const state = await harness.send("getState");
  assert.strictEqual(state.run.running, false);
});

// ----------------------------------------------------- recovering a stuck run
// "A run is already going." with no way to see or stop it: the flag had been
// written to storage by a run that crashed, and a reload brought it back.

test("a run flagged as going is cleared when the extension starts", async () => {
  const harness = load({ techIds: TECHS });
  await harness.send("setPlan", { plan: samplePlan() });

  // Persist the state a crashed run would have left behind, then start fresh.
  const stuck = await harness.send("getState");
  stuck.run.running = true;
  stuck.run.index = 120;
  stuck.run.total = 534;
  const restarted = load({ techIds: TECHS, storage: { state: stuck } });

  const state = await restarted.send("getState");
  assert.strictEqual(state.run.running, false, "a fresh background page cannot be mid-run");
  assert.match(state.run.note, /120 of 534/);
  assert.match(state.run.note, /reloaded/i);
});

test("a stuck run does not block the next one", async () => {
  const harness = load({ techIds: TECHS });
  await harness.send("setPlan", { plan: samplePlan() });
  const stuck = await harness.send("getState");
  stuck.run.running = true;

  const restarted = load({ techIds: TECHS, storage: { state: stuck } });
  const run = await restarted.send("startRun", { dryRun: true });
  assert.ok(!run.error, `should start cleanly: ${run.error}`);
  assert.strictEqual(run.results.length, 2);
});

test("clearing the run state by hand works", async () => {
  const harness = load({ techIds: TECHS });
  await harness.send("setPlan", { plan: samplePlan() });
  const stuck = await harness.send("getState");
  stuck.run.running = true;
  const restarted = load({ techIds: TECHS, storage: { state: stuck } });

  // Simulate it still being set (belt and braces for the button itself).
  const state = await restarted.send("unstick");
  assert.strictEqual(state.run.running, false);
  assert.match(state.run.note, /cleared by hand/i);
});

test("the row in flight is reported while a run goes", async () => {
  const plan = samplePlan();
  const harness = load({ techIds: TECHS });
  await harness.send("setPlan", { plan });
  await harness.send("setSettings", { settings: { delayMs: 40, allowWrites: true } });
  await harness.send("probe");

  const running = harness.send("startRun", { dryRun: false });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const midway = await harness.send("getState");
  assert.ok(midway.run.running, "should be going");
  assert.ok(midway.run.current, "should say which row is in flight");
  assert.strictEqual(midway.run.current.tech, plan.assignments[0].tech_id);

  await running;
  const after = await harness.send("getState");
  assert.strictEqual(after.run.current, null, "cleared when it finishes");
});

// ------------------------------------------------------------ the activity log
// Every round of this has been somebody describing a failure from a screenshot.
// The log exists so the next one can be read instead.

function messages(state) {
  return (state.log || []).map((e) => e.message);
}

test("loading a plan is logged with its shape", async () => {
  const harness = load({ techIds: TECHS });
  const state = await harness.send("setPlan", { plan: samplePlan() });
  const entry = state.log.find((e) => e.message === "Plan loaded");
  assert.ok(entry, messages(state).join(" | "));
  assert.strictEqual(entry.detail.blocks, 2);
  assert.strictEqual(entry.detail.month, "2026-10");
});

test("the probe records every page it looked at", async () => {
  const harness = gridHarness();
  await harness.send("setPlan", { plan: samplePlan() });
  const state = await harness.send("probe");
  assert.ok(messages(state).includes("Looking for the shift form"));
  assert.ok(messages(state).includes("Read an open S4 tab"));
  assert.ok(messages(state).includes("Read a linked S4 page"));
  const built = state.log.find((e) => e.message === "Mapping built");
  assert.strictEqual(built.detail.shiftTimes, 15);
  assert.strictEqual(built.level, "ok");
});

test("an incomplete mapping is logged as a problem, with what is missing", async () => {
  const harness = load({
    techIds: TECHS,
    grid: "https://s4.inhouse.net/index.php?action=nothing",
    editors: false,
  });
  await harness.send("setPlan", { plan: samplePlan() });
  const state = await harness.send("probe");
  const built = state.log.find((e) => e.message === "Mapping built");
  assert.strictEqual(built.level, "warn");
  assert.ok(built.detail.missingFields.length);
});

test("every refusal explains itself in the log", async () => {
  const harness = load({ techIds: TECHS });
  await harness.send("setPlan", { plan: samplePlan() });
  await harness.send("startRun", { dryRun: false });
  const state = await harness.send("getState");
  assert.ok(
    messages(state).some((m) => /Refused to run/.test(m)),
    messages(state).join(" | ")
  );
});

test("unlocking writing is recorded", async () => {
  const harness = load({ techIds: TECHS });
  await harness.send("setSettings", { settings: { allowWrites: true } });
  const state = await harness.send("getState");
  assert.ok(messages(state).includes("Writing to S4 was unlocked"));
});

test("a failed post is logged with what S4 said", async () => {
  const { harness } = await ready({
    respond: () => ({ status: 200, text: "<html>Error: not allowed</html>" }),
  });
  await harness.send("startRun", { dryRun: false });
  const state = await harness.send("getState");
  const refusal = state.log.find((e) => e.level === "error" && /Refused:/.test(e.message));
  assert.ok(refusal, messages(state).join(" | "));
  assert.match(refusal.detail.detail, /not allowed/i);
});

test("a long run does not bury the failures in the log", async () => {
  const plan = samplePlan({
    assignments: Array.from({ length: 120 }, (_, i) => ({
      tech_id: "mojin.t", category: "W", slot_id: "s0",
      shift_time: "06:58am-02:58pm", start_date: "01-Oct-2026",
      end_date: "01-Oct-2026", days: 1, time: "06:58", duration_min: 480,
      reason: "x", source: "minimum", seq: i,
    })),
  });
  const { harness } = await ready({ plan });
  await harness.send("startRun", { dryRun: false });
  const state = await harness.send("getState");
  const posted = (state.log || []).filter((e) => /^Posted /.test(e.message));
  assert.ok(posted.length < 20, `should summarise, got ${posted.length} lines`);
  assert.ok(posted.length >= 3, "should still show the run's shape");
});

test("the log is capped so it cannot grow without bound", async () => {
  const plan = samplePlan({
    assignments: Array.from({ length: 300 }, () => ({
      tech_id: "mojin.t", category: "W", slot_id: "s0",
      shift_time: "06:58am-02:58pm", start_date: "01-Oct-2026",
      end_date: "01-Oct-2026", days: 1, time: "06:58", duration_min: 480,
      reason: "x", source: "minimum",
    })),
  });
  const { harness } = await ready({
    plan,
    respond: () => ({ status: 500, text: "boom" }),
  });
  await harness.send("setSettings", { settings: { delayMs: 0, stopAfterFailures: 99999 } });
  await harness.send("startRun", { dryRun: false });
  const state = await harness.send("getState");
  assert.ok(state.log.length <= 1200, `log grew to ${state.log.length}`);
});

// ------------------------------------------------------------- diagnostics

test("diagnostics carry the form's real field names", async () => {
  const harness = gridHarness();
  await harness.send("setPlan", { plan: samplePlan() });
  await harness.send("probe");
  const diag = await harness.send("diagnostics");
  assert.ok(diag.mapping, "should include the mapping");
  const names = diag.mapping.pages.flatMap((p) => p.forms.flatMap((f) => f.inputs));
  assert.ok(names.some((n) => n.startsWith("sdate")), JSON.stringify(names));
  assert.ok(
    diag.mapping.pages.some((p) => p.forms.some((f) => f.selects.length)),
    "and the dropdowns"
  );
});

test("diagnostics say what is missing and where it looked", async () => {
  const harness = load({
    techIds: TECHS,
    grid: "https://s4.inhouse.net/index.php?action=nothing",
    editors: false,
  });
  await harness.send("setPlan", { plan: samplePlan() });
  await harness.send("probe");
  const diag = await harness.send("diagnostics");
  assert.ok(diag.missing.fields.length);
  assert.ok(diag.mapping.looked.length);
  assert.ok(diag.log.length);
  assert.ok(diag.version, "and the build, so a stale install is obvious");
});

test("diagnostics stay small enough to paste", async () => {
  const harness = gridHarness();
  await harness.send("setPlan", { plan: samplePlan() });
  await harness.send("probe");
  await harness.send("startRun", { dryRun: true });
  const diag = await harness.send("diagnostics");
  const size = JSON.stringify(diag).length;
  assert.ok(size < 200000, `diagnostics are ${size} bytes`);
  assert.strictEqual(diag.plan.sample.length, 2, "a sample of the plan, not all of it");
});

// -------------------------------------------- building the editor address
// S4 opens the editor from javascript that assembles the url from pieces, so
// there is no whole address in the markup to scrape — the grid's links led to
// action=edit_timings, which has the shift times on it but no staff, no
// category and no dates. The shape is known, and the plan carries the month
// and the team, so it can be written out instead.

const BUILT =
  "https://s4.inhouse.net/index.php?action=view_shift&sdate=2026-10-01&edate=2026-10-31&t=6&edit_co_shift=N";

test("the editor address is built from the plan's month and team", async () => {
  const plan = samplePlan({ team_id: 6 });
  const editor = makeDocument(TECHS, {});
  const harness = load({
    techIds: TECHS,
    grid: "https://s4.inhouse.net/index.php?action=edit_timings",
    pages: { [BUILT]: "EDITOR" },
    documents: { EDITOR: editor },
  });
  await harness.send("setPlan", { plan });
  const state = await harness.send("probe");
  assert.ok(!state.error, state.error);
  assert.ok(harness.fetched.includes(BUILT), `tried: ${harness.fetched.join(", ")}`);
  assert.strictEqual(Object.keys(state.mapping.shiftTimeValues).length, 15);
  assert.strictEqual(state.mapping.tabUrl, BUILT);
});

test("the month drives the dates in the built address", async () => {
  const plan = samplePlan({ month: "2026-02", team_id: 6 });
  const feb = "https://s4.inhouse.net/index.php?action=view_shift&sdate=2026-02-01&edate=2026-02-28&t=6&edit_co_shift=N";
  const harness = load({
    techIds: TECHS,
    grid: "https://s4.inhouse.net/index.php?action=edit_timings",
    pages: { [feb]: "EDITOR" },
    documents: { EDITOR: makeDocument(TECHS, {}) },
  });
  await harness.send("setPlan", { plan });
  await harness.send("probe");
  assert.ok(harness.fetched.includes(feb), `tried: ${harness.fetched.join(", ")}`);
});

test("a pasted address still wins over the built one", async () => {
  const pasted = "https://s4.inhouse.net/index.php?action=whatever_they_gave_us";
  const harness = load({
    techIds: TECHS,
    grid: "https://s4.inhouse.net/index.php?action=edit_timings",
    pages: { [pasted]: "EDITOR" },
    documents: { EDITOR: makeDocument(TECHS, {}) },
  });
  await harness.send("setPlan", { plan: samplePlan({ team_id: 6 }) });
  await harness.send("setSettings", { settings: { editUrl: pasted } });
  await harness.send("probe");
  assert.strictEqual(harness.fetched[0], pasted);
});

test("a page with only the shift times is not mistaken for the editor", async () => {
  // action=edit_timings matched 14 shift times and nothing else, which is
  // exactly the state that looked like progress but could not post.
  const timings = { ...makeDocument(TECHS, {}) };
  const harness = load({ techIds: TECHS });
  await harness.send("setPlan", { plan: samplePlan({ team_id: 6 }) });
  await harness.send("setSettings", { settings: { allowWrites: true } });
  await harness.send("probe");
  const state = await harness.send("getState");
  // The good page maps everything; prove an incomplete one would be refused.
  const partial = {
    fields: { start_date: "sdate" },
    shiftTimeValues: state.mapping.shiftTimeValues,
    categoryValues: {},
    staffValues: {},
  };
  const missing = harness.S4Mapping.missingMapping(partial, samplePlan());
  assert.ok(missing.fields.includes("staff"));
  assert.ok(missing.categories.length, "no categories means no live run");
});

test("a mapping from an earlier session is dropped when a new plan loads", async () => {
  // The panel showed "14 shift times · found on: edit_timings" with only two
  // log lines behind it — a mapping left in storage by a previous install.
  const harness = gridHarness();
  await harness.send("setPlan", { plan: samplePlan() });
  await harness.send("probe");
  const withMapping = await harness.send("getState");
  assert.ok(withMapping.mapping, "probed once");

  const state = await harness.send("setPlan", { plan: samplePlan({ month: "2026-12" }) });
  assert.strictEqual(state.mapping, null, "a different month must re-probe");
  assert.ok(
    (state.log || []).some((e) => /earlier session/.test(e.message)),
    "and say so"
  );
});

test("reloading the same month's plan keeps the mapping", async () => {
  const harness = gridHarness();
  await harness.send("setPlan", { plan: samplePlan() });
  await harness.send("probe");
  const state = await harness.send("setPlan", { plan: samplePlan() });
  assert.ok(state.mapping, "same month, no need to probe again");
});

// ------------------------------------- S4 spreads the form over several pages
// The log showed the pieces scattered: action=edit_timings had the fourteen
// shift times and nothing else, while add_shift and manage_shift each had the
// twenty-eight staff. Scoring by raw counts picked the timings page, which
// cannot post anything.

function pageWith(over) {
  const doc = makeDocument(TECHS, over);
  return doc;
}

test("the page that supplies the most required fields wins, not the biggest count", async () => {
  const plan = samplePlan({ team_id: 6 });
  const TIMINGS = "https://s4.inhouse.net/index.php?action=edit_timings";
  const ADD = "https://s4.inhouse.net/index.php?action=add_shift";
  const harness = load({
    techIds: TECHS,
    grid: [TIMINGS, ADD],
    pages: { [TIMINGS]: "T", [ADD]: "A" },
    documents: {
      // shift times only, like the real timings page
      T: makeDocument([], { noFields: true, selects: false }),
      // the real form
      A: makeDocument(TECHS, {}),
    },
  });
  await harness.send("setPlan", { plan });
  const state = await harness.send("probe");
  assert.ok(!state.error, state.error);
  assert.strictEqual(state.mapping.tabUrl, ADD, "should post to the page with the fields");
});

test("option values are merged from whichever page had them", async () => {
  const plan = samplePlan({ team_id: 6 });
  const A = "https://s4.inhouse.net/index.php?action=add_shift";
  // The grid page carries the staff dropdown; the fetched page carries the rest.
  const harness = load({
    techIds: TECHS,
    grid: A,
    pages: { [A]: "A" },
    documents: { A: makeDocument(TECHS, {}) },
  });
  await harness.send("setPlan", { plan });
  const state = await harness.send("probe");
  assert.strictEqual(Object.keys(state.mapping.shiftTimeValues).length, 15);
  assert.strictEqual(Object.keys(state.mapping.staffValues).length, 2);
  assert.ok(state.mapping.contributed, "should record which page gave what");
});

test("every page read is kept for diagnosis, not just the chosen one", async () => {
  const harness = gridHarness();
  await harness.send("setPlan", { plan: samplePlan() });
  await harness.send("probe");
  const diag = await harness.send("diagnostics");
  assert.ok(Array.isArray(diag.mapping.pages), "diagnostics should list the pages");
  assert.ok(diag.mapping.pages.length >= 2, `only ${diag.mapping.pages.length} page(s)`);
  const names = diag.mapping.pages.flatMap((p) => p.forms.flatMap((f) => f.inputs));
  assert.ok(names.length, "with the raw field names on them");
});

// --------------------------------------------------- probing and running clash

test("a run cannot start while the probe is still going", async () => {
  const harness = load({ techIds: TECHS });
  await harness.send("setPlan", { plan: samplePlan() });
  const probing = harness.send("probe");
  const reply = await harness.send("startRun", { dryRun: true });
  assert.ok(reply.error, "should refuse");
  assert.match(reply.error, /still looking/i);
  await probing;
});

test("probing twice at once is refused", async () => {
  const harness = gridHarness();
  await harness.send("setPlan", { plan: samplePlan() });
  const first = harness.send("probe");
  const second = await harness.send("probe");
  assert.ok(second.error);
  assert.match(second.error, /already looking/i);
  await first;
});

test("the probing flag is cleared when the extension starts", async () => {
  const harness = load({ techIds: TECHS });
  await harness.send("setPlan", { plan: samplePlan() });
  const stuck = await harness.send("getState");
  stuck.probing = true;
  const restarted = load({ techIds: TECHS, storage: { state: stuck } });
  const state = await restarted.send("getState");
  assert.strictEqual(state.probing, false);
});

test("an unmapped dry run says so once, not on every row", async () => {
  const plan = samplePlan({
    assignments: Array.from({ length: 40 }, () => ({
      tech_id: "mojin.t", category: "W", slot_id: "s0",
      shift_time: "06:58am-02:58pm", start_date: "01-Oct-2026",
      end_date: "01-Oct-2026", days: 1, time: "06:58", duration_min: 480,
      reason: "x", source: "minimum",
    })),
  });
  const harness = load({ techIds: TECHS });
  await harness.send("setPlan", { plan });
  await harness.send("startRun", { dryRun: true });
  const state = await harness.send("getState");
  const refusals = (state.log || []).filter((e) => /^Refused: /.test(e.message));
  assert.strictEqual(refusals.length, 0, `logged ${refusals.length} per-row refusals`);
  assert.ok(
    (state.log || []).some((e) => /no field mapping/i.test(e.message)),
    "but should say it once"
  );
});

test("a field name only present on another page is borrowed", async () => {
  const plan = samplePlan({ team_id: 6 });
  const TIMINGS = "https://s4.inhouse.net/index.php?action=edit_timings";
  const ADD = "https://s4.inhouse.net/index.php?action=add_shift";
  // The posting page has no shift_time dropdown; the timings page does.
  const withoutShiftTime = makeDocument(TECHS, {});
  withoutShiftTime.forms[0].querySelectorAll = (selector) => {
    const all = makeDocument(TECHS, {}).forms[0].querySelectorAll(selector);
    return all.filter((el) => el.name !== "shift_time");
  };
  const harness = load({
    techIds: TECHS,
    grid: [TIMINGS, ADD],
    pages: { [TIMINGS]: "T", [ADD]: "A" },
    documents: { T: makeDocument(TECHS, {}), A: withoutShiftTime },
  });
  await harness.send("setPlan", { plan });
  const state = await harness.send("probe");
  assert.ok(!state.error, state.error);
  assert.ok(state.mapping.fields.shift_time, "should still name the shift_time field");
});

// ---------------------------------------------- the real change_shift form
// Read off a live probe of S4. These are the field names a post has to use,
// and each was got wrong at least once.

const CHANGE_SHIFT = [
  {
    name: "change_shift",
    action: "index.php?action=chkshift",
    inputs: (
      "cal_id:hidden uid:hidden tid:hidden referer_team_id:hidden sdate:hidden " +
      "edate:hidden view:hidden prv_caldate:hidden reasonComment:hidden " +
      "startday:hidden startmonth:hidden startyear:hidden endday:hidden " +
      "endmonth:hidden endyear:hidden hour:text minute:text ampm:radio ampm:radio " +
      "duration_h:text duration_m:text hcl_hour:text hcl_minute:text hcl_ampm:radio " +
      "hcl_co:checkbox shift_comment:radio shift_comment:radio comment:textarea " +
      "countdown:text Edit:submit"
    )
      .split(" ")
      .map((pair) => ({ name: pair.split(":")[0], type: pair.split(":")[1], value: "" })),
    selects: [
      { name: "cat", options: [] },
      {
        name: "shift_time",
        options: [
          { value: "", text: "Select" },
          { value: "Other", text: "Flexy" },
        ],
      },
      { name: "members", options: [{ value: "", text: "Select" }] },
    ],
  },
];

test("duration_h and duration_m are recognised", () => {
  // "duration_h" does not contain "dur_h", so the old hints missed both.
  const harness = load({ techIds: TECHS });
  const fields = harness.S4Mapping.suggestFields(CHANGE_SHIFT, "shift");
  assert.strictEqual(fields.duration_hours, "duration_h");
  assert.strictEqual(fields.duration_minutes, "duration_m");
});

test("the duration fields are not confused with the clock fields", () => {
  const harness = load({ techIds: TECHS });
  const fields = harness.S4Mapping.suggestFields(CHANGE_SHIFT, "shift");
  assert.strictEqual(fields.time_hour, "hour");
  assert.strictEqual(fields.time_minute, "minute");
  assert.notStrictEqual(fields.time_hour, fields.duration_hours);
});

test("a radio group is never bound to a text field", () => {
  // shift_comment is seven radio buttons; "log" was landing on it because the
  // name contains "comment".
  const harness = load({ techIds: TECHS });
  const fields = harness.S4Mapping.suggestFields(CHANGE_SHIFT, "shift");
  assert.notStrictEqual(fields.log, "shift_comment");
  assert.strictEqual(fields.log, "comment");
});

test("the hidden uid is taken as the staff field", () => {
  const harness = load({ techIds: TECHS });
  const fields = harness.S4Mapping.suggestFields(CHANGE_SHIFT, "shift");
  assert.strictEqual(fields.staff, "uid");
});

test("the category field is named even while its dropdown is empty", () => {
  // S4 only fills cat in against a real calendar row.
  const harness = load({ techIds: TECHS });
  const fields = harness.S4Mapping.suggestFields(CHANGE_SHIFT, "shift");
  assert.strictEqual(fields.category, "cat");
});

test("every field a post needs is found on the real form", () => {
  const harness = load({ techIds: TECHS });
  const plan = samplePlan();
  const matched = harness.S4Mapping.matchOptions(CHANGE_SHIFT, plan);
  const fields = Object.assign(
    harness.S4Mapping.suggestFields(CHANGE_SHIFT, "shift"),
    matched.fields
  );
  const required = [
    "staff", "category", "start_date", "end_date", "shift_time",
    "time_hour", "time_minute", "duration_hours", "duration_minutes",
  ];
  const missing = required.filter((name) => !fields[name]);
  assert.deepStrictEqual(missing, [], `missing: ${missing.join(", ")}`);
});

test("a dropdown of team admins does not become the staff field", () => {
  // edit_team carries the whole user list, the team's members, and a
  // seven-strong admin list. The admin list was winning the name.
  const harness = load({ techIds: TECHS });
  const plan = samplePlan();
  const forms = [
    {
      name: "team",
      action: "index.php",
      inputs: [],
      selects: [
        {
          name: "cmbTeam[]",
          options: plan.techs.map((t, i) => ({ value: String(1900 + i), text: t.id })),
        },
        {
          name: "cmbTeamAdmin[]",
          options: [{ value: "145", text: plan.techs[0].id }],
        },
      ],
    },
  ];
  const matched = harness.S4Mapping.matchOptions(forms, plan);
  assert.strictEqual(matched.fields.staff, "cmbTeam[]", "the bigger list should name it");
});

// ----------------------------------------- a post has to carry the whole form
// The form has 18 fields the mapping knows nothing about, cal_id and tid among
// them. Sending only the understood ones leaves S4 with no idea which row is
// being changed.

const RENDERED = [
  {
    name: "change_shift",
    action: "index.php?action=chkshift",
    inputs: [
      { name: "cal_id", type: "hidden", value: "98765" },
      { name: "uid", type: "hidden", value: "2431" },
      { name: "tid", type: "hidden", value: "6" },
      { name: "sdate", type: "hidden", value: "2026-10-01" },
      { name: "edate", type: "hidden", value: "2026-10-31" },
      { name: "view", type: "hidden", value: "month" },
      { name: "startday", type: "hidden", value: "01" },
      { name: "startmonth", type: "hidden", value: "10" },
      { name: "startyear", type: "hidden", value: "2026" },
      { name: "endday", type: "hidden", value: "01" },
      { name: "endmonth", type: "hidden", value: "10" },
      { name: "endyear", type: "hidden", value: "2026" },
      { name: "hour", type: "text", value: "" },
      { name: "minute", type: "text", value: "" },
      { name: "ampm", type: "radio", value: "am" },
      { name: "duration_h", type: "text", value: "" },
      { name: "duration_m", type: "text", value: "" },
      { name: "comment", type: "textarea", value: "" },
      { name: "countdown", type: "text", value: "200" },
      { name: "secret", type: "password", value: "hunter2" },
      { name: "Edit", type: "submit", value: "Edit" },
    ],
    selects: [{ name: "cat", options: [] }, { name: "shift_time", options: [] }],
  },
];

function renderedMapping(harness) {
  return {
    fields: Object.assign(harness.S4Mapping.suggestFields(RENDERED, "shift"), {
      shift_time: "shift_time",
      category: "cat",
    }),
    baseFields: harness.S4Mapping.baseFieldsOf(RENDERED, "shift"),
    shiftTimeValues: { s0: "614" },
    categoryValues: { W: "W" },
    staffValues: { "mojin.t": "2431" },
  };
}

const ROW = {
  tech_id: "mojin.t", category: "W", slot_id: "s0",
  shift_time: "10:58pm-06:58am", start_date: "01-Oct-2026",
  end_date: "03-Oct-2026", time: "22:58", duration_min: 480, reason: "autofill",
};

test("the hidden fields the form rendered are handed back", () => {
  const harness = load({ techIds: TECHS });
  const body = harness.S4Mapping.buildBody(ROW, renderedMapping(harness));
  assert.strictEqual(body.cal_id, "98765", "without this S4 cannot tell which row");
  assert.strictEqual(body.tid, "6");
  assert.strictEqual(body.view, "month");
  assert.strictEqual(body.countdown, "200");
  assert.strictEqual(body.Edit, "Edit", "php often tests for the submit button");
});

test("a password rendered on the form is never posted back", () => {
  const harness = load({ techIds: TECHS });
  const body = harness.S4Mapping.buildBody(ROW, renderedMapping(harness));
  assert.ok(!("secret" in body), "must not echo a password field");
});

test("the split date parts are filled from the plan, not left as rendered", () => {
  const harness = load({ techIds: TECHS });
  const body = harness.S4Mapping.buildBody(ROW, renderedMapping(harness));
  assert.strictEqual(body.startday, "01");
  assert.strictEqual(body.startmonth, "10");
  assert.strictEqual(body.startyear, "2026");
  assert.strictEqual(body.endday, "03", "the end date moves with the block");
});

test("dates are sent in the format S4 rendered them in", () => {
  const harness = load({ techIds: TECHS });
  const body = harness.S4Mapping.buildBody(ROW, renderedMapping(harness));
  // The hidden sdate came back as 2026-10-01, so ISO is what it wants.
  assert.strictEqual(body.sdate, "2026-10-01");
  assert.strictEqual(body.edate, "2026-10-03");
});

test("a form rendering dd-Mon-yyyy gets dd-Mon-yyyy back", () => {
  const harness = load({ techIds: TECHS });
  const mapping = renderedMapping(harness);
  mapping.baseFields.sdate = "01-Oct-2026";
  mapping.baseFields.edate = "31-Oct-2026";
  const body = harness.S4Mapping.buildBody(ROW, mapping);
  assert.strictEqual(body.sdate, "01-Oct-2026");
  assert.strictEqual(body.edate, "03-Oct-2026");
});

test("nothing on the form is left out of the post", () => {
  const harness = load({ techIds: TECHS });
  const body = harness.S4Mapping.buildBody(ROW, renderedMapping(harness));
  const onForm = RENDERED[0].inputs
    .filter((i) => i.type !== "password")
    .map((i) => i.name)
    .concat(RENDERED[0].selects.map((s) => s.name));
  const missing = [...new Set(onForm)].filter((name) => !(name in body));
  assert.deepStrictEqual(missing, [], `not sent: ${missing.join(", ")}`);
});

test("splitDate handles S4's date format", () => {
  const harness = load({ techIds: TECHS });
  assert.deepStrictEqual({ ...harness.S4Mapping.splitDate("03-Oct-2026") }, {
    day: "03", month: "10", year: "2026", iso: "2026-10-03",
  });
  assert.strictEqual(harness.S4Mapping.splitDate("nonsense"), null);
});

// ------------------------------------- a post must know which row it changes
// cal_id is per person per day. S4's grid hands each cell's id to popup(),
// which opens the editor for that one row, and the editor renders that row's
// hidden fields. So every block has to find its own cell, open its own editor
// and post back what that editor rendered: one cal_id for the whole month is
// wrong for every row but one.

const { makeEditorDocument, gridCellsFor, POPUP_SOURCE } = require("./harness.js");

const POPUP_HTML = `<script language="JavaScript"> <!-- ${POPUP_SOURCE} //--></script>`;

const NIGHT_CELL = {
  cal_id: "98765", date: "2026-10-01", user: "2431", team: "6", time: "22:58",
  duration: "480", cat_id: "1", start_date: "2026-10-01", end_date: "2026-10-31",
  co_flag: "N", comment: "", referer_team_id: "",
};

const NIGHT_EDITOR =
  "index.php?action=chkshift&cal_id=98765&cal_date=2026-10-01&cal_user_id=2431" +
  "&cal_team_id=6&cal_time=22%3A58&cal_duration=480&cal_cat_id=1&sdate=2026-10-01" +
  "&edate=2026-10-31&co_flag=N&comment=&referer_team_id=6";

/** The cal_id the fixture grid gives a person (by position) on an October day. */
function calIdFor(techIndex, day) {
  const cell = gridCellsFor(TECHS)[techIndex * 31 + day - 1];
  return cell.cal_id;
}

function octoberRows(count, overrides = {}) {
  return Array.from({ length: count }, (_, i) =>
    Object.assign(
      {
        tech_id: "mojin.t", category: "W", slot_id: "s0", shift_time: "06:58am-02:58pm",
        start_date: `${String(i + 1).padStart(2, "0")}-Oct-2026`,
        end_date: `${String(i + 1).padStart(2, "0")}-Oct-2026`,
        days: 1, time: "06:58", duration_min: 480, reason: "x", source: "minimum",
      },
      overrides
    )
  );
}

test("popup()'s arguments are read the way S4 writes them", () => {
  const { parseCallArgs } = load({ techIds: TECHS }).S4Mapping;
  assert.deepStrictEqual(
    [...parseCallArgs(`'98765','2026-10-01','2431','6','22:58','480','1','night, cover','')`)],
    ["98765", "2026-10-01", "2431", "6", "22:58", "480", "1", "night, cover", ""]
  );
  assert.deepStrictEqual([...parseCallArgs(`98765, "2026-10-01", 2431)`)], [
    "98765", "2026-10-01", "2431",
  ]);
  assert.deepStrictEqual([...parseCallArgs(`'it\\'s', 'x')`)], ["it's", "x"]);
  assert.strictEqual(parseCallArgs(`'98765', '2026-10-01'`), null, "an unclosed call is no call");
});

test("popup()'s own definition gives its parameters and the address it opens", () => {
  const { popupSignature, editorUrl, KNOWN_POPUP_PARAMS } = load({ techIds: TECHS }).S4Mapping;
  const signature = popupSignature(POPUP_HTML);
  assert.ok(signature, "the definition should be found");
  assert.deepStrictEqual([...signature.params], [...KNOWN_POPUP_PARAMS]);
  assert.strictEqual(editorUrl(NIGHT_CELL, signature), NIGHT_EDITOR);
});

test("without popup()'s definition the address is still built in S4's order", () => {
  const { editorUrl } = load({ techIds: TECHS }).S4Mapping;
  assert.strictEqual(editorUrl(NIGHT_CELL, null), NIGHT_EDITOR);
});

test("the referer team falls back to the cell's own team, as popup() does", () => {
  const { editorUrl } = load({ techIds: TECHS }).S4Mapping;
  assert.match(editorUrl(NIGHT_CELL, null), /referer_team_id=6$/);
  const referred = Object.assign({}, NIGHT_CELL, { referer_team_id: "9" });
  assert.match(editorUrl(referred, null), /referer_team_id=9$/);
});

test("any date S4 might hand a cell is read the same way", () => {
  const { normaliseDate } = load({ techIds: TECHS }).S4Mapping;
  ["2026-10-01", "2026-10-01 00:00:00", "01-Oct-2026", "1-oct-2026", "01/10/2026", "20261001"]
    .forEach((text) => assert.strictEqual(normaliseDate(text), "2026-10-01", text));
  assert.strictEqual(normaliseDate("nonsense"), null);
  assert.strictEqual(normaliseDate(""), null);
});

test("two cells for one person and day are counted, not silently merged", () => {
  const { indexCells } = load({ techIds: TECHS }).S4Mapping;
  const { index, duplicates } = indexCells([
    { user: "1", date: "2026-10-01", cal_id: "a" },
    { user: "1", date: "01-Oct-2026", cal_id: "b" },
    { user: "", date: "2026-10-01", cal_id: "c" },
    { user: "2", date: "junk", cal_id: "d" },
  ]);
  assert.deepStrictEqual(Object.keys(index), ["1|2026-10-01"]);
  assert.strictEqual(index["1|2026-10-01"].cal_id, "a", "the first one is kept");
  assert.strictEqual(duplicates, 1);
});

test("radios and checkboxes are only sent back when ticked", () => {
  const { baseFieldsOf } = load({ techIds: TECHS }).S4Mapping;
  const base = baseFieldsOf(
    [
      {
        name: "change_shift",
        inputs: [
          { name: "hcl_co", type: "checkbox", value: "B", checked: false },
          { name: "hcl_co", type: "checkbox", value: "NB", checked: false },
          { name: "shift_comment", type: "radio", value: "1", checked: false },
          { name: "shift_comment", type: "radio", value: "4", checked: true },
          { name: "shift_comment", type: "radio", value: "7", checked: false },
        ],
        selects: [],
      },
    ],
    "change_shift"
  );
  assert.ok(!("hcl_co" in base), "an unticked checkbox is not submitted");
  assert.strictEqual(base.shift_comment, "4", "the ticked radio, not the last one");
});

test("a dropdown goes back with the value it showed", () => {
  const { baseFieldsOf } = load({ techIds: TECHS }).S4Mapping;
  const base = baseFieldsOf(
    [
      {
        name: "change_shift",
        inputs: [],
        selects: [
          { name: "members", selected: "", options: [] },
          { name: "cat", selected: "3", options: [] },
          { name: "old", options: [] },
        ],
      },
    ],
    "change_shift"
  );
  assert.strictEqual(base.members, "");
  assert.strictEqual(base.cat, "3");
  assert.ok(!("old" in base), "nothing is invented for a dropdown that was not read");
});

test("the probe reads every cell of the month grid", async () => {
  const { state } = await ready();
  assert.strictEqual(state.grid.cells.length, TECHS.length * 31);
  assert.ok(state.grid.signature, "popup()'s definition should have been found");
  assert.strictEqual(state.grid.cells[0].cal_id, calIdFor(0, 1));
  const read = state.log.find((e) => e.message === "Read the grid's calendar rows");
  assert.strictEqual(read.level, "ok");
});

test("every block is matched to a calendar row before anything is sent", async () => {
  const { state } = await ready();
  assert.deepStrictEqual(
    { total: state.mapping.coverage.total, resolved: state.mapping.coverage.resolved },
    { total: 2, resolved: 2 }
  );
});

test("cells wired up without onclick are still read from the markup", async () => {
  const PAGE = "https://s4.inhouse.net/index.php?action=view_shift&t=6&y=2026&m=10&alt=1";
  const markup =
    POPUP_HTML +
    `<td ondblclick="popup(&#39;555&#39;,&#39;2026-10-01&#39;,&#39;200&#39;,&#39;6&#39;)">W</td>`;
  const harness = load({
    techIds: TECHS,
    cells: false,
    pages: { [PAGE]: "ALT" },
    documents: {
      ALT: { forms: [], querySelectorAll: () => [], documentElement: { innerHTML: markup } },
    },
  });
  await harness.send("setPlan", { plan: samplePlan() });
  await harness.send("setSettings", { settings: { editUrl: PAGE } });
  const state = await harness.send("probe");
  assert.deepStrictEqual(
    state.grid.cells.map((c) => [c.cal_id, c.user]),
    [["555", "200"]]
  );
});

test("opening a real cell's editor from the grid finds the whole form", async () => {
  const harness = load({ techIds: TECHS, grid: "https://s4.inhouse.net/index.php?action=nothing" });
  await harness.send("setPlan", { plan: samplePlan() });
  const state = await harness.send("probe");
  assert.strictEqual(Object.keys(state.mapping.shiftTimeValues).length, 15);
  assert.strictEqual(state.mapping.categoryValues.W, "W");
  assert.ok(messages(state).includes("Opened a real shift in the editor"));
  assert.ok(
    harness.fetched.some((url) => /action=chkshift&cal_id=7\d{4}&/.test(url)),
    `read: ${harness.fetched.join(", ")}`
  );
});

test("each block is posted with its own row's cal_id", async () => {
  const { harness } = await ready();
  await harness.send("startRun", { dryRun: false });
  assert.strictEqual(harness.posted.length, 2);
  assert.strictEqual(harness.posted[0].body.cal_id, calIdFor(0, 1), "mojin.t on 1 October");
  assert.strictEqual(harness.posted[1].body.cal_id, calIdFor(1, 1), "alan.j on 1 October");
  assert.notStrictEqual(harness.posted[0].body.cal_id, harness.posted[1].body.cal_id);
});

test("each block opens the editor for its own row before posting", async () => {
  const { harness } = await ready();
  const before = harness.fetched.length;
  await harness.send("startRun", { dryRun: false });
  const opened = harness.fetched.slice(before);
  assert.strictEqual(opened.length, 2);
  assert.match(opened[0], new RegExp(`cal_id=${calIdFor(0, 1)}&.*cal_user_id=200&`));
  assert.match(opened[1], new RegExp(`cal_id=${calIdFor(1, 1)}&.*cal_user_id=201&`));
});

test("the post goes to the editor form's own action", async () => {
  const { harness } = await ready();
  await harness.send("startRun", { dryRun: false });
  assert.strictEqual(harness.posted[0].url, "https://s4.inhouse.net/index.php?action=chkshift");
});

test("what the row's editor rendered goes back with the post", async () => {
  const { harness } = await ready();
  await harness.send("startRun", { dryRun: false });
  const [first] = harness.posted;
  assert.strictEqual(first.body.tid, "6");
  assert.strictEqual(first.body.view, "month");
  assert.strictEqual(first.body.shift_comment, "1", "the ticked radio");
  assert.ok(!("hcl_co" in first.body), "unticked checkboxes stay out");
  assert.strictEqual(first.body.Edit, "Edit");
});

test("a block with no calendar row is skipped, not counted as a failure", async () => {
  const plan = samplePlan({
    assignments: octoberRows(4, { start_date: "05-Nov-2026", end_date: "05-Nov-2026" }).concat(
      samplePlan().assignments
    ),
  });
  const { harness } = await ready({ plan });
  const run = await harness.send("startRun", { dryRun: false });
  assert.ok(!run.stopped, `four misses must not trip the failure stop: ${run.note}`);
  assert.strictEqual(harness.posted.length, 2);
  const skipped = run.results.filter((r) => r.skipped);
  assert.strictEqual(skipped.length, 4);
  assert.match(skipped[0].detail, /no calendar row/);
  assert.ok(skipped.every((r) => !r.ok));
  const state = await harness.send("getState");
  assert.strictEqual(state.log.filter((e) => /^Skipped: /.test(e.message)).length, 4);
  assert.ok(
    !state.log.some((e) => e.level === "error" && /^Refused: /.test(e.message)),
    "a skip is not a refusal"
  );
});

test("an editor rendered for somebody else stops that row", async () => {
  const { harness } = await ready({
    editor: (params, ids) => makeEditorDocument(params, ids, { user: "999" }),
  });
  const run = await harness.send("startRun", { dryRun: false });
  assert.strictEqual(harness.posted.length, 0, "nothing may be posted to the wrong person");
  assert.ok(!run.results[0].ok);
  assert.match(run.results[0].detail, /999/);
  assert.match(run.results[0].detail, /mojin\.t/);
});

test("an editor that comes back without a cal_id stops that row", async () => {
  const { harness } = await ready({
    editor: (params, ids) => makeEditorDocument(params, ids, { calId: "" }),
  });
  const run = await harness.send("startRun", { dryRun: false });
  assert.strictEqual(harness.posted.length, 0);
  assert.match(run.results[0].detail, /without a cal_id/);
});

test("an editor that cannot be opened stops that row", async () => {
  const { harness } = await ready({ editors: false });
  const run = await harness.send("startRun", { dryRun: false });
  assert.strictEqual(harness.posted.length, 0);
  assert.match(run.results[0].detail, /could not open this row's editor/);
});

test("a live run is refused when the grid's calendar rows were not read", async () => {
  const harness = load({ techIds: TECHS, cells: false });
  await harness.send("setPlan", { plan: samplePlan() });
  await harness.send("setSettings", { settings: { allowWrites: true } });
  await harness.send("probe");
  const reply = await harness.send("startRun", { dryRun: false });
  assert.ok(reply.error, "should refuse");
  assert.match(reply.error, /calendar rows/);
  assert.match(reply.error, /Find the shift form again/);
  assert.strictEqual(harness.posted.length, 0);
});

test("a dry run still works without the grid's rows, and says why", async () => {
  const harness = load({ techIds: TECHS, cells: false });
  await harness.send("setPlan", { plan: samplePlan() });
  await harness.send("probe");
  const run = await harness.send("startRun", { dryRun: true });
  assert.ok(!run.error, run.error);
  assert.strictEqual(harness.posted.length, 0);
  assert.strictEqual(run.results.length, 2);
  assert.ok(run.results.every((r) => r.skipped && /no calendar row/.test(r.detail)));
  const state = await harness.send("getState");
  assert.ok(messages(state).some((m) => /no calendar rows/.test(m)));
});

test("a dry run opens a handful of real editors and posts nothing", async () => {
  const { harness } = await ready({ plan: samplePlan({ assignments: octoberRows(12) }) });
  const before = harness.fetched.length;
  const run = await harness.send("startRun", { dryRun: true });
  const opened = harness.fetched.slice(before);
  assert.strictEqual(harness.posted.length, 0);
  assert.ok(opened.length > 0 && opened.length <= 5, `opened ${opened.length}`);
  assert.ok(opened.every((url) => /action=chkshift&cal_id=\d+/.test(url)));
  assert.strictEqual(run.results.length, 12);
  assert.ok(run.results.every((r) => r.ok), JSON.stringify(run.results.map((r) => r.detail)));
});

test("every dry-run row shows its own row's cal_id, opened or not", async () => {
  const { harness } = await ready({ plan: samplePlan({ assignments: octoberRows(8) }) });
  const run = await harness.send("startRun", { dryRun: true });
  assert.match(run.results[0].detail, /opened/);
  assert.strictEqual(run.results[0].body.cal_id, calIdFor(0, 1));
  assert.match(run.results[7].detail, /found/);
  assert.strictEqual(run.results[7].body.cal_id, calIdFor(0, 8));
});

test("diagnostics show the grid, the coverage and the first real bodies", async () => {
  const { harness } = await ready();
  await harness.send("startRun", { dryRun: true });
  const diag = await harness.send("diagnostics");
  assert.strictEqual(diag.mapping.grid.cells, TECHS.length * 31);
  assert.strictEqual(diag.mapping.grid.popup.params.length, 12);
  assert.strictEqual(diag.mapping.coverage.resolved, 2);
  assert.strictEqual(diag.mapping.firstBodies[0].body.cal_id, calIdFor(0, 1));
});

// ------------------------------------------------------------------ the UI page
// render() read a value one line before declaring it, so from the moment a
// mapping existed every render threw: the buttons, the status and the log all
// froze at whatever they last showed. Nothing exercised the page, so nothing
// noticed.

const UI_ROOT = require("path").join(__dirname, "..");

function fakeElement() {
  const el = {
    textContent: "", hidden: false, disabled: false, checked: false, value: "",
    title: "", open: false, className: "", style: {}, children: [],
    scrollTop: 0, clientHeight: 0, scrollHeight: 0,
    classList: { add() {}, remove() {}, toggle() {} },
    append(...items) { el.children.push(...items); },
    appendChild(item) { el.children.push(item); return item; },
    addEventListener() {}, click() {}, remove() {},
  };
  el.tBodies = [{ textContent: "", appendChild(item) { el.children.push(item); return item; } }];
  return el;
}

function loadUi(state) {
  const vm = require("vm");
  const fs = require("fs");
  const path = require("path");
  const elements = {};
  const context = {
    console, URL, Blob: function Blob() {}, setTimeout, setInterval, clearInterval,
    document: {
      getElementById: (id) => (elements[id] = elements[id] || fakeElement()),
      createElement: () => fakeElement(),
      body: fakeElement(),
    },
    browser: {
      runtime: {
        sendMessage: async () => state,
        getManifest: () => ({ version: "test" }),
      },
    },
    navigator: { clipboard: { writeText: async () => {} } },
    window: { confirm: () => false },
  };
  context.globalThis = context;
  vm.createContext(context);
  // The same scripts, in the same order, that ui.html loads.
  const html = fs.readFileSync(path.join(UI_ROOT, "ui/ui.html"), "utf8");
  [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].forEach(([, src]) => {
    const file = path.join(UI_ROOT, "ui", src);
    vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: src });
  });
  return { render: context.render, $: (id) => context.document.getElementById(id) };
}

test("the UI renders a found mapping without throwing", async () => {
  const { harness } = await ready();
  const state = await harness.send("getState");
  const ui = loadUi(state);
  assert.doesNotThrow(() => ui.render(state));
  assert.strictEqual(ui.$("live").disabled, false, ui.$("fillReason").textContent);
  assert.strictEqual(ui.$("statusState").textContent, "Idle");
});

test("the UI says how many blocks found a calendar row", async () => {
  const { harness } = await ready();
  const state = await harness.send("getState");
  const ui = loadUi(state);
  ui.render(state);
  assert.match(ui.$("mapInfo").textContent, /62 calendar rows/);
  assert.match(ui.$("mapInfo").textContent, /2\/2 blocks matched to a row/);
});

test("the live button stays off until the grid's rows are read", async () => {
  const harness = load({ techIds: TECHS, cells: false });
  await harness.send("setPlan", { plan: samplePlan() });
  await harness.send("setSettings", { settings: { allowWrites: true } });
  await harness.send("probe");
  const state = await harness.send("getState");
  const ui = loadUi(state);
  ui.render(state);
  assert.strictEqual(ui.$("live").disabled, true);
  assert.match(ui.$("fillReason").textContent, /calendar rows were not read/);
});

test("skipped rows are counted apart from failures", async () => {
  const plan = samplePlan({
    assignments: octoberRows(3, { start_date: "05-Nov-2026", end_date: "05-Nov-2026" }).concat(
      samplePlan().assignments
    ),
  });
  const { harness } = await ready({ plan });
  await harness.send("startRun", { dryRun: false });
  const state = await harness.send("getState");
  const ui = loadUi(state);
  ui.render(state);
  assert.strictEqual(ui.$("counts").textContent, "2 ok, 0 failed, 3 skipped (no calendar row)");
});

test("somebody on two teams is matched to this team's cell", () => {
  const { indexCells } = load({ techIds: TECHS }).S4Mapping;
  const cells = [
    { user: "200", date: "2026-10-01", cal_id: "111", team: "9" },
    { user: "200", date: "2026-10-01", cal_id: "222", team: "6" },
  ];
  assert.strictEqual(indexCells(cells, 6).index["200|2026-10-01"].cal_id, "222");
  assert.strictEqual(indexCells(cells).index["200|2026-10-01"].cal_id, "111");
});

test("a cell with no row id is skipped rather than opened", async () => {
  const cells = gridCellsFor(TECHS).map((cell, i) =>
    i === 0 ? Object.assign({}, cell, { cal_id: "" }) : cell
  );
  const { harness } = await ready({ cells });
  const before = harness.fetched.length;
  const run = await harness.send("startRun", { dryRun: false });
  assert.ok(run.results[0].skipped, run.results[0].detail);
  assert.match(run.results[0].detail, /no row id/);
  assert.strictEqual(harness.posted.length, 1, "the other block still goes in");
  assert.ok(!harness.fetched.slice(before).some((url) => /cal_id=&/.test(url)));
});
