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
  const harness = load({ techIds: TECHS, selects: false });
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
  // Without following the link this is what the person saw.
  const harness = load({ techIds: TECHS, grid: EDITOR_URL });
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
