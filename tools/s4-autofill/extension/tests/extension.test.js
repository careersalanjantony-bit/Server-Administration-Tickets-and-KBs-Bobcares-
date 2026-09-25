"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { load, samplePlan } = require("./harness.js");

const TECHS = ["mojin.t", "alan.j"];

async function ready(options = {}) {
  const harness = load(Object.assign({ techIds: TECHS }, options));
  await harness.send("setPlan", { plan: options.plan || samplePlan() });
  await harness.send("setSettings", { settings: { delayMs: 0 } });
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
  await harness.send("setSettings", { settings: { delayMs: 25 } });
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
