/*
 * Holds the plan, the field mapping and the run state.
 *
 * This lives in the background rather than the popup because the popup is torn
 * down the moment it loses focus — a run driven from there would die as soon as
 * the person clicked away. Progress is written to storage as it goes, so the
 * popup can be closed and reopened mid-run.
 */
"use strict";

const DEFAULT_STATE = {
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
  },
  settings: { delayMs: 700, stopAfterFailures: 3 },
};

let state = JSON.parse(JSON.stringify(DEFAULT_STATE));
let stopRequested = false;

async function load() {
  const saved = await browser.storage.local.get("state");
  if (saved && saved.state) state = Object.assign({}, state, saved.state);
}
const ready = load();

async function save() {
  await browser.storage.local.set({ state });
}

async function s4Tab() {
  const tabs = await browser.tabs.query({ url: "*://s4.inhouse.net/*" });
  if (!tabs.length) {
    throw new Error("No S4 tab is open. Open the shift page in a tab and try again.");
  }
  return tabs[0];
}

async function ask(message) {
  const tab = await s4Tab();
  try {
    return await browser.tabs.sendMessage(tab.id, message);
  } catch (error) {
    throw new Error(
      "Could not reach the S4 page. Reload the S4 tab so the extension loads into it, " +
        `then try again. (${error.message})`
    );
  }
}

function payloadsFrom(plan) {
  return (plan && plan.assignments) || [];
}

async function runPlan(dryRun) {
  await ready;
  if (state.run.running) throw new Error("A run is already going.");
  if (!state.plan) throw new Error("Load a plan first.");
  if (!state.mapping) throw new Error("Probe the S4 form first.");

  const payloads = payloadsFrom(state.plan);
  const missing = S4Mapping.missingMapping(state.mapping, state.plan);
  if (!dryRun && (missing.fields.length || missing.slots.length || missing.categories.length)) {
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

  stopRequested = false;
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
  };
  await save();

  const action = state.mapping.action || "";
  let failures = 0;

  for (let i = 0; i < payloads.length; i += 1) {
    if (stopRequested) {
      state.run.stopped = true;
      state.run.note = `Stopped after ${i} of ${payloads.length}.`;
      break;
    }
    const payload = payloads[i];
    const body = S4Mapping.buildBody(payload, state.mapping);
    let result;
    if (dryRun) {
      result = { ok: true, detail: "dry run — nothing sent", body };
    } else {
      try {
        result = await ask({ type: "post", body, action });
      } catch (error) {
        result = { ok: false, detail: error.message };
      }
      result.body = body;
    }
    if (!result.ok) failures += 1;

    state.run.results.push({
      tech: payload.tech_id,
      slot: payload.slot_id,
      shift: payload.shift_time,
      from: payload.start_date,
      to: payload.end_date,
      days: payload.days,
      why: payload.source || "",
      ok: !!result.ok,
      detail: result.detail || "",
      body: result.body,
    });
    state.run.index = i + 1;
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

  state.run.running = false;
  state.run.finishedAt = new Date().toISOString();
  await save();
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
    await save();
    return state;
  },

  async probe() {
    await ready;
    if (!state.plan) throw new Error("Load a plan first — the labels in it drive the matching.");
    const { forms } = await ask({ type: "probe" });
    const matched = S4Mapping.matchOptions(forms, state.plan);
    const formName = state.plan.form_name || "shift";
    const fields = Object.assign(S4Mapping.suggestFields(forms, formName), matched.fields);
    const target = forms.find((f) => f.name === formName) || forms[0];
    state.mapping = {
      fields,
      shiftTimeValues: matched.shiftTimeValues,
      categoryValues: matched.categoryValues,
      staffValues: matched.staffValues,
      unmatched: matched.unmatched,
      constantFields: state.mapping ? state.mapping.constantFields || {} : {},
      action: target ? target.action : "",
      probedAt: new Date().toISOString(),
      forms,
    };
    await save();
    return state;
  },

  async startRun({ dryRun }) {
    return runPlan(!!dryRun);
  },

  async stopRun() {
    stopRequested = true;
    return { ok: true };
  },

  async reset() {
    await ready;
    state.run = JSON.parse(JSON.stringify(DEFAULT_STATE.run));
    await save();
    return state;
  },

  async setSettings({ settings }) {
    await ready;
    state.settings = Object.assign({}, state.settings, settings);
    await save();
    return state;
  },
};

browser.runtime.onMessage.addListener((message) => {
  const handler = handlers[message && message.type];
  if (!handler) return undefined;
  return handler(message).catch((error) => ({ error: error.message }));
});
