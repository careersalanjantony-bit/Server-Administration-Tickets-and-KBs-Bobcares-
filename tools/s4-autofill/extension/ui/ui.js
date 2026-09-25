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

/** The month an S4 url is showing, e.g. ...&y=2026&m=12 -> "2026-12". */
function monthOfUrl(url) {
  const year = /[?&]y=(\d{4})\b/.exec(url || "");
  const month = /[?&]m=(\d{1,2})\b/.exec(url || "");
  if (!year || !month) return null;
  return `${year[1]}-${String(month[1]).padStart(2, "0")}`;
}

function planNotes(plan, mapping) {
  if (!plan) return [];
  const notes = [];
  const shortfalls = (plan.issues && plan.issues.shortfalls) || [];
  if (shortfalls.length) {
    notes.push(
      `This plan has ${shortfalls.length} coverage shortfall(s) — ` +
        `${shortfalls[0]}${shortfalls.length > 1 ? ", …" : ""}. ` +
        "Those days go in short-staffed."
    );
  }
  // The dates in each post decide which month is written, not the page you are
  // looking at — but a mismatch usually means the wrong plan got loaded.
  const showing = mapping && monthOfUrl(mapping.tabUrl);
  if (showing && plan.month && showing !== plan.month) {
    notes.push(
      `The S4 page it found is showing ${showing}, but this plan is for ` +
        `${plan.month}. Each post carries its own dates, so ${plan.month} is ` +
        "what would be written — check that is the one you meant."
    );
  }
  return notes;
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
  if (state.settings && $("editUrl").value === "") {
    $("editUrl").value = state.settings.editUrl || "";
  }
  // Open the fallback on its own once the automatic search has come up short.
  if (mapping && !mappingClean) $("editorDetails").open = true;
  const mappingClean = listProblems(mapping, plan);

  const busy = run.running;
  const allowed = !!(state.settings && state.settings.allowWrites);
  $("allowWrites").checked = allowed;
  $("allowWrites").disabled = busy;

  // A dry run sends nothing, so the only thing that can stop it is not having
  // a plan. Everything else is a reason the *live* button is off.
  $("dryRun").disabled = busy || !plan;
  $("live").disabled = busy || !plan || !mapping || !mappingClean || !allowed;

  // Never leave a greyed-out button without saying why.
  const why = [];
  if (busy) why.push("a run is going — Stop it first");
  if (!plan) why.push("load a plan to enable the dry run");
  if (plan && !busy) {
    if (!mapping) why.push("find the shift form before filling for real");
    else if (!mappingClean) why.push("the mapping is incomplete, so filling for real is off");
    if (mapping && mappingClean && !allowed) {
      why.push("tick “Allow writing to S4” to enable filling");
    }
  }
  $("fillReason").textContent = why.length ? why.join(" · ") : "";
  $("dryRun").title = $("dryRun").disabled ? why.join(" · ") : "Builds the posts without sending them";
  $("live").title = $("live").disabled ? why.join(" · ") : "";
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
  const notes = planNotes(plan, mapping).concat(run.note ? [run.note] : []);
  $("runNote").hidden = notes.length === 0;
  $("runNote").textContent = notes.join("  ");

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

async function loadPlanText(text, what) {
  try {
    const plan = JSON.parse(text);
    const state = await call("setPlan", { plan });
    if (state) render(state);
  } catch (error) {
    showError(`Could not read ${what}: ${error.message}`);
  }
}

$("planFile").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  await loadPlanText(await file.text(), file.name);
});

const drop = $("drop");
["dragenter", "dragover"].forEach((name) =>
  drop.addEventListener(name, (event) => {
    event.preventDefault();
    drop.classList.add("over");
  })
);
["dragleave", "drop"].forEach((name) =>
  drop.addEventListener(name, () => drop.classList.remove("over"))
);
drop.addEventListener("drop", async (event) => {
  event.preventDefault();
  const file = event.dataTransfer.files[0];
  if (file) await loadPlanText(await file.text(), file.name);
});

$("planPasteLoad").addEventListener("click", async () => {
  const text = $("planPaste").value.trim();
  if (!text) return showError("Nothing pasted.");
  await loadPlanText(text, "the pasted plan");
});

$("probe").addEventListener("click", async () => {
  $("probe").textContent = "Looking…";
  const state = await call("probe");
  $("probe").textContent = "Find the shift form";
  if (state) render(state);
});

$("editUrlSave").addEventListener("click", async () => {
  await call("setSettings", { settings: { editUrl: $("editUrl").value.trim() } });
  $("probe").click();
});

$("allowWrites").addEventListener("change", async (event) => {
  const state = await call("setSettings", {
    settings: { allowWrites: event.target.checked },
  });
  if (state) render(state);
});

$("delay").addEventListener("change", async (event) => {
  await call("setSettings", { settings: { delayMs: Number(event.target.value) || 0 } });
});

$("dryRun").addEventListener("click", async () => {
  await call("startRun", { dryRun: true });
  // Shown so it is obvious which build is loaded — several have been handed
// round and they are indistinguishable otherwise.
$("build").textContent = "v" + browser.runtime.getManifest().version;

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
  // Shown so it is obvious which build is loaded — several have been handed
// round and they are indistinguishable otherwise.
$("build").textContent = "v" + browser.runtime.getManifest().version;

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

// Shown so it is obvious which build is loaded — several have been handed
// round and they are indistinguishable otherwise.
$("build").textContent = "v" + browser.runtime.getManifest().version;

refresh();
