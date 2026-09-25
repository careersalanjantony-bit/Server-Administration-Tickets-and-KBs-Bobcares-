/*
 * Popup UI. Holds no state of its own — the background script owns the run, so
 * closing this window mid-run does not stop anything, and reopening it picks
 * the progress back up.
 */
"use strict";

const $ = (id) => document.getElementById(id);
const REFRESH_MS = 400;
let timer = null;

function send(type, extra) {
  return browser.runtime.sendMessage(Object.assign({ type }, extra || {}));
}

function showError(message) {
  const box = $("error");
  box.hidden = !message;
  box.textContent = message || "";
}

async function call(type, extra) {
  showError("");
  const reply = await send(type, extra);
  if (reply && reply.error) {
    showError(reply.error);
    return null;
  }
  return reply;
}

function describePlan(plan) {
  if (!plan) return "No plan loaded.";
  const rows = plan.assignments.length;
  const techs = new Set(plan.assignments.map((a) => a.tech_id)).size;
  const days = plan.assignments.reduce((total, a) => total + (a.days || 1), 0);
  return `${rows} shift blocks · ${techs} techs · ${days} tech-days`;
}

function describeMapping(mapping, plan) {
  if (!mapping) return "Not read yet.";
  const slots = Object.keys(mapping.shiftTimeValues || {}).length;
  const cats = Object.keys(mapping.categoryValues || {}).length;
  const staff = Object.keys(mapping.staffValues || {}).length;
  const fields = Object.keys(mapping.fields || {}).length;
  return `${fields} fields · ${slots} shift times · ${cats} categories · ${staff} staff`;
}

function listProblems(mapping, plan) {
  const list = $("mapProblems");
  list.textContent = "";
  if (!mapping || !plan) return true;
  const missing = S4Mapping.missingMapping(mapping, plan);
  const lines = [];
  if (missing.fields.length) lines.push(`form fields not found: ${missing.fields.join(", ")}`);
  if (missing.slots.length) lines.push(`shift times not matched: ${missing.slots.join(", ")}`);
  if (missing.categories.length) lines.push(`categories not matched: ${missing.categories.join(", ")}`);
  Object.entries(mapping.unmatched || {}).forEach(([name, options]) => {
    if (options && options.length) {
      lines.push(`dropdown "${name}" has options nothing matched: ${options.join(", ")}`);
    }
  });
  lines.forEach((text) => {
    const li = document.createElement("li");
    li.textContent = text;
    list.appendChild(li);
  });
  return lines.length === 0;
}

function renderResults(run) {
  const section = $("resultsSection");
  const rows = run.results || [];
  section.hidden = rows.length === 0;
  if (!rows.length) return;

  const ok = rows.filter((r) => r.ok).length;
  const bad = rows.length - ok;
  $("counts").textContent =
    `${ok} ok, ${bad} failed` + (run.dryRun ? " (dry run)" : "");

  const onlyFailures = $("failuresOnly").checked;
  const shown = onlyFailures ? rows.filter((r) => !r.ok) : rows;
  const body = $("results").tBodies[0];
  body.textContent = "";
  shown.slice(-300).forEach((row) => {
    const tr = document.createElement("tr");
    const state = document.createElement("td");
    state.className = "state " + (row.ok ? "ok" : "bad");
    state.textContent = row.ok ? "✓" : "✕";
    const what = document.createElement("td");
    const days = row.days > 1 ? ` (${row.days}d)` : "";
    what.textContent = `${row.tech}  ${row.from}→${row.to}${days}  ${row.shift || ""}`;
    if (row.why) what.title = `chosen by: ${row.why}`;
    const detail = document.createElement("td");
    detail.className = "detail";
    detail.textContent = row.detail || "";
    tr.append(state, what, detail);
    body.appendChild(tr);
  });
}

function render(state) {
  if (!state) return;
  const { plan, mapping, run } = state;
  $("month").textContent = plan && plan.month ? plan.month : "";
  $("planInfo").textContent = describePlan(plan);
  $("mapInfo").textContent = describeMapping(mapping, plan);
  $("mapWhere").textContent = mapping && mapping.tabUrl
    ? `found on: ${mapping.tabUrl}`
    : "";
  const mappingClean = listProblems(mapping, plan);

  const busy = run.running;
  $("dryRun").disabled = busy || !plan || !mapping;
  $("live").disabled = busy || !plan || !mapping || !mappingClean;
  $("probe").disabled = busy || !plan;
  $("planFile").disabled = busy;
  $("stop").hidden = !busy;

  $("progressWrap").hidden = !(busy || run.total);
  if (run.total) {
    const pct = Math.round((run.index / run.total) * 100);
    $("bar").style.width = pct + "%";
    $("progressText").textContent =
      `${run.index} of ${run.total}` + (run.dryRun ? " — dry run" : "") +
      (busy ? "" : " — finished");
  }
  $("runNote").hidden = !run.note;
  $("runNote").textContent = run.note || "";

  renderResults(run);

  if (busy && !timer) timer = setInterval(refresh, REFRESH_MS);
  if (!busy && timer) {
    clearInterval(timer);
    timer = null;
  }
}

async function refresh() {
  const state = await send("getState");
  render(state);
}

$("planFile").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    const plan = JSON.parse(await file.text());
    const state = await call("setPlan", { plan });
    if (state) render(state);
  } catch (error) {
    showError(`Could not read that file: ${error.message}`);
  }
});

$("probe").addEventListener("click", async () => {
  const state = await call("probe");
  if (state) render(state);
});

$("delay").addEventListener("change", async (event) => {
  await call("setSettings", { settings: { delayMs: Number(event.target.value) || 0 } });
});

$("dryRun").addEventListener("click", async () => {
  await call("startRun", { dryRun: true });
  refresh();
});

$("live").addEventListener("click", async () => {
  const state = await send("getState");
  const count = state.plan.assignments.length;
  const month = state.plan.month || "this month";
  const confirmed = window.confirm(
    `Write ${count} shift blocks into S4 for ${month}?\n\n` +
      "This changes the live roster. Run a dry run first if you have not."
  );
  if (!confirmed) return;
  await call("startRun", { dryRun: false });
  refresh();
});

$("stop").addEventListener("click", async () => {
  await call("stopRun");
});

$("reset").addEventListener("click", async () => {
  const state = await call("reset");
  if (state) render(state);
});

$("failuresOnly").addEventListener("change", refresh);

$("copy").addEventListener("click", async () => {
  const state = await send("getState");
  const lines = (state.run.results || []).map(
    (r) =>
      `${r.ok ? "ok  " : "FAIL"}\t${r.tech}\t${r.from}\t${r.to}\t${r.shift || ""}\t${r.detail}`
  );
  await navigator.clipboard.writeText(lines.join("\n"));
  $("copy").textContent = "copied";
  setTimeout(() => ($("copy").textContent = "Copy log"), 1200);
});

refresh();
