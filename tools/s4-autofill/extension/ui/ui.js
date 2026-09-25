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
  const parts = [
    `${fields} fields`, `${slots} shift times`, `${cats} categories`, `${staff} staff`,
  ];
  // Each block posts to its own calendar row, so how many found one is the
  // number that says whether a live run can do its job.
  if (mapping.gridCells !== undefined) parts.push(`${mapping.gridCells} calendar rows`);
  if (mapping.coverage) {
    parts.push(`${mapping.coverage.resolved}/${mapping.coverage.total} blocks matched to a row`);
  }
  return parts.join(" · ");
}

/** Whether the grid's calendar rows were read, which a live run cannot do without. */
function rowsRead(mapping) {
  return !!(mapping && mapping.gridCells);
}

function listProblems(mapping, plan) {
  const list = $("mapProblems");
  list.textContent = "";
  if (!mapping || !plan) return true;
  // Only what the plan needs holds the run — the same rule the background
  // refuses on. The rest is listed so nothing about the form is hidden.
  const { blocking, info } = S4Mapping.mappingProblems(mapping, plan);
  const coverage = mapping.coverage;
  if (coverage && coverage.missing && rowsRead(mapping)) {
    info.push(
      `${coverage.missing} block(s) have no calendar row in the grid and would be skipped` +
        (coverage.examples && coverage.examples.length ? ` — e.g. ${coverage.examples[0]}` : "")
    );
  }
  blocking.forEach((text) => addProblem(list, text, true));
  info.forEach((text) => addProblem(list, text, false));
  return blocking.length === 0;
}

function addProblem(list, text, blocks) {
  const li = document.createElement("li");
  li.textContent = text;
  if (!blocks) li.className = "info";
  list.appendChild(li);
}

function renderResults(run) {
  const section = $("resultsSection");
  const rows = run.results || [];
  section.hidden = rows.length === 0;
  if (!rows.length) return;

  const ok = rows.filter((r) => r.ok).length;
  const skipped = rows.filter((r) => r.skipped).length;
  const bad = rows.length - ok - skipped;
  const unchanged = rows.filter((r) => r.unchanged).length;
  $("counts").textContent =
    `${ok} ok, ${bad} failed` +
    (skipped ? `, ${skipped} skipped (no calendar row)` : "") +
    (unchanged ? ` · ${unchanged} already in S4` : "") +
    (run.dryRun ? " (dry run)" : "");

  const onlyFailures = $("failuresOnly").checked;
  const shown = onlyFailures ? rows.filter((r) => !r.ok) : rows;
  const body = $("results").tBodies[0];
  body.textContent = "";
  shown.slice(-300).forEach((row) => {
    const tr = document.createElement("tr");
    const state = document.createElement("td");
    state.className = "state " + (row.ok ? "ok" : row.skipped ? "skip" : "bad");
    state.textContent = row.unchanged ? "=" : row.ok ? "✓" : row.skipped ? "–" : "✕";
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

/** One line on how the one-row test went, and what to do if it did not. */
function describeTest(test) {
  if (!test) return "";
  const head = `${test.tech} on ${test.date}: ${test.from} → ${test.to} → back.`;
  if (test.changed && test.restored) {
    return `${head} S4 took the change and it was put back. Posting works.`;
  }
  if (!test.restored) {
    return `${head} The day was NOT put back — set ${test.tech} on ${test.date} to ` +
      `${test.from} by hand in S4. Copy diagnostics for what S4 said.`;
  }
  return `${head} S4 did not show the change, so nothing was written; the day is as it ` +
    "was. Copy diagnostics for what S4 said.";
}

function renderStatus(run, busy, probing) {
  const box = $("status");
  const pct = run.total ? Math.round((run.index / run.total) * 100) : 0;
  $("bar").style.width = pct + "%";

  let label = "Idle";
  if (probing) label = "Looking for the shift form";
  else if (busy) label = run.dryRun ? "Dry run going" : "Filling S4";
  else if (run.total && run.index >= run.total) label = "Finished";
  else if (run.total) label = "Stopped";
  $("statusState").textContent = label;

  const bits = [];
  if (run.total) bits.push(`${run.index} of ${run.total} (${pct}%)`);
  if (run.dryRun && run.total) bits.push("nothing was sent");
  if (run.startedAt) bits.push(`started ${new Date(run.startedAt).toLocaleTimeString()}`);
  if (!busy && run.finishedAt) {
    bits.push(`ended ${new Date(run.finishedAt).toLocaleTimeString()}`);
  }
  $("statusDetail").textContent = bits.join(" · ");

  // What is in flight right now, so a long run is legible while it happens.
  $("statusCurrent").textContent = run.current
    ? `now: ${run.current.tech}  ${run.current.from}→${run.current.to}  ${run.current.shift || ""}`
    : "";

  // The only way out of a run that says it is going but is not.
  $("unstick").hidden = !run.running;
  box.classList.toggle("going", busy);
}

function renderLog(state) {
  const entries = state.log || [];
  const problemsOnly = $("logProblems").checked;
  const shown = problemsOnly
    ? entries.filter((e) => e.level === "warn" || e.level === "error")
    : entries;

  $("logCount").textContent = `${entries.length} entries` +
    (problemsOnly ? ` · showing ${shown.length}` : "");

  const box = $("log");
  const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 24;
  box.textContent = "";
  shown.slice(-400).forEach((entry) => {
    const line = document.createElement("div");
    const time = document.createElement("span");
    time.className = "t";
    time.textContent = new Date(entry.t).toLocaleTimeString() + "  ";
    const level = document.createElement("b");
    level.className = entry.level;
    level.textContent = entry.level.toUpperCase().padEnd(5) + " ";
    const text = document.createElement("span");
    text.textContent = entry.message +
      (entry.detail ? "  " + JSON.stringify(entry.detail) : "");
    line.append(time, level, text);
    box.appendChild(line);
  });
  if (atBottom) box.scrollTop = box.scrollHeight;
}

function logAsText(entries) {
  return (entries || [])
    .map(
      (e) =>
        `${e.t}  ${e.level.toUpperCase().padEnd(5)} ${e.message}` +
        (e.detail ? "  " + JSON.stringify(e.detail) : "")
    )
    .join("\n");
}

function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function flash(button, word) {
  const was = button.textContent;
  button.textContent = word;
  setTimeout(() => (button.textContent = was), 1200);
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
  const mappingClean = listProblems(mapping, plan);
  // Open the fallback on its own once the automatic search has come up short.
  // (This used to run a line before mappingClean existed, which threw on every
  // render once a mapping was found and froze the buttons, status and log.)
  if (mapping && !mappingClean) $("editorDetails").open = true;

  const busy = run.running || state.probing;
  const allowed = !!(state.settings && state.settings.allowWrites);
  $("allowWrites").checked = allowed;
  $("allowWrites").disabled = busy;

  // A dry run sends nothing, so the only thing that can stop it is not having
  // a plan. Everything else is a reason the *live* button is off.
  $("dryRun").disabled = busy || !plan;
  $("live").disabled =
    busy || !plan || !mapping || !mappingClean || !rowsRead(mapping) || !allowed;

  // Never leave a greyed-out button without saying why.
  const why = [];
  if (state.probing) why.push("still looking for the shift form — this takes a few seconds");
  else if (busy) why.push("a run is going — Stop it first");
  if (!plan) why.push("load a plan to enable the dry run");
  if (plan && !busy) {
    if (!mapping) why.push("find the shift form before filling for real");
    else if (!mappingClean) why.push("the mapping is incomplete, so filling for real is off");
    else if (!rowsRead(mapping)) {
      why.push(
        "the grid's calendar rows were not read — open the month in S4 and " +
          "Find the shift form again"
      );
    }
    if (mapping && mappingClean && rowsRead(mapping) && !allowed) {
      why.push("tick “Allow writing to S4” to enable filling");
    }
  }
  $("fillReason").textContent = why.length ? why.join(" · ") : "";
  $("dryRun").title = $("dryRun").disabled ? why.join(" · ") : "Builds the posts without sending them";
  $("live").title = $("live").disabled ? why.join(" · ") : "";
  $("testOne").disabled = busy || !mapping || !rowsRead(mapping) || !allowed;
  $("testOne").title = $("testOne").disabled
    ? "needs the shift form found, the grid read, and writing unlocked"
    : "";
  $("testResult").textContent = describeTest(state.lastTest);
  $("probe").disabled = busy || !plan;
  $("probe").textContent = state.probing ? "Looking…" : "Find the shift form";
  $("planFile").disabled = busy;
  $("stop").hidden = !busy;

  renderStatus(run, busy, !!state.probing);
  const notes = planNotes(plan, mapping).concat(run.note ? [run.note] : []);
  $("runNote").hidden = notes.length === 0;
  $("runNote").textContent = notes.join("  ");

  renderResults(run);
  renderLog(state);

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
  $("probe").disabled = true;
  $("probe").textContent = "Looking…";
  refresh();
  const state = await call("probe");
  if (state) render(state);
  else refresh();
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
  refresh();
});

$("live").addEventListener("click", async () => {
  const state = await send("getState");
  const count = state.plan.assignments.length;
  const month = state.plan.month || "this month";
  const coverage = state.mapping && state.mapping.coverage;
  const lines = [];
  if (coverage && coverage.changing !== undefined) {
    lines.push(
      `${coverage.changing} block(s) replace what S4 shows now` +
        (coverage.changedDays ? ` (${coverage.changedDays} day(s) of the existing roster)` : "") +
        "."
    );
    if (coverage.unchanged) lines.push(`${coverage.unchanged} already match S4 and are left alone.`);
  }
  if (coverage && coverage.missing) {
    lines.push(`${coverage.missing} have no calendar row in the grid and will be skipped.`);
  }
  const confirmed = window.confirm(
    `Write ${count} shift blocks into S4 for ${month}?\n` +
      (lines.length ? `\n${lines.join("\n")}\n` : "") +
      "\nThis changes the live roster. Run a dry run first if you have not."
  );
  if (!confirmed) return;
  await call("startRun", { dryRun: false });
  refresh();
});

$("testOne").addEventListener("click", async () => {
  const args = { tech: $("testTech").value.trim(), date: $("testDate").value.trim() };
  const pick = await call("planTest", args);
  if (!pick) return;
  const confirmed = window.confirm(
    `Test on ${pick.tech}, ${pick.date} (row ${pick.calId}):\n\n` +
      `S4 now: ${pick.from}\n` +
      `1. change it to ${pick.to}\n` +
      "2. read S4 back to check it saved\n" +
      `3. change it back to ${pick.from}\n` +
      "4. read S4 back to check it is restored\n\n" +
      "This writes to the live roster twice. Continue?"
  );
  if (!confirmed) return;
  $("testResult").textContent = "Testing…";
  $("testOne").disabled = true;
  await call("runTest", args);
  refresh();
});

$("stop").addEventListener("click", async () => {
  await call("stopRun");
});

$("unstick").addEventListener("click", async () => {
  const state = await call("unstick");
  if (state) render(state);
});

$("reset").addEventListener("click", async () => {
  const state = await call("reset");
  if (state) render(state);
});

$("failuresOnly").addEventListener("change", refresh);
$("logProblems").addEventListener("change", refresh);

$("logCopy").addEventListener("click", async () => {
  const state = await send("getState");
  await navigator.clipboard.writeText(logAsText(state.log));
  flash($("logCopy"), "copied");
});

$("logDownload").addEventListener("click", async () => {
  const state = await send("getState");
  const month = (state.plan && state.plan.month) || "s4";
  download(`s4-autofill-${month}-log.txt`, logAsText(state.log));
});

$("logClear").addEventListener("click", async () => {
  const state = await call("clearLog");
  if (state) render(state);
});

$("diagCopy").addEventListener("click", async () => {
  const diag = await call("diagnostics");
  if (!diag) return;
  await navigator.clipboard.writeText(JSON.stringify(diag, null, 2));
  flash($("diagCopy"), "copied — paste it wherever you need");
});

$("diagDownload").addEventListener("click", async () => {
  const diag = await call("diagnostics");
  if (!diag) return;
  const month = (diag.plan && diag.plan.month) || "s4";
  download(`s4-autofill-${month}-diagnostics.json`, JSON.stringify(diag, null, 2));
});

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
