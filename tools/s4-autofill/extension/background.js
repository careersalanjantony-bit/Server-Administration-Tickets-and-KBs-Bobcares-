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
  // Writing is off until somebody deliberately turns it on. A dry run is
  // the common case and a mis-click on the live button would otherwise go
  // straight into a roster people are working to.
  settings: { delayMs: 700, stopAfterFailures: 3, allowWrites: false, editUrl: "" },
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
/** Has this page got everything a live run needs? */
function isComplete(forms, plan) {
  const matched = S4Mapping.matchOptions(forms, plan);
  const fields = Object.assign(
    S4Mapping.suggestFields(forms, plan.form_name || "shift"),
    matched.fields
  );
  const missing = S4Mapping.missingMapping(
    {
      fields,
      shiftTimeValues: matched.shiftTimeValues,
      categoryValues: matched.categoryValues,
      staffValues: matched.staffValues,
    },
    plan
  );
  return !missing.fields.length && !missing.slots.length && !missing.categories.length;
}

function scoreForms(forms, plan) {
  const matched = S4Mapping.matchOptions(forms, plan);
  const fields = S4Mapping.suggestFields(forms, plan.form_name || "shift");
  return (
    Object.keys(matched.shiftTimeValues).length * 3 +
    Object.keys(matched.categoryValues).length * 2 +
    Object.keys(matched.staffValues).length +
    Object.keys(Object.assign(fields, matched.fields)).length
  );
}

function payloadsFrom(plan) {
  return (plan && plan.assignments) || [];
}

async function runPlan(dryRun) {
  await ready;
  if (state.run.running) throw new Error("A run is already going.");
  if (!state.plan) throw new Error("Load a plan first.");
  if (!state.mapping) throw new Error("Probe the S4 form first.");
  if (!dryRun && !state.settings.allowWrites) {
    throw new Error(
      "Writing to S4 is locked. Tick \u201cAllow writing to S4\u201d first — " +
        "dry runs work without it."
    );
  }

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

    const tabs = await s4Tabs();
    const looked = [];
    let best = null;
    let host = null;
    let candidates = [];

    for (const tab of tabs) {
      let reply;
      try {
        reply = await askTab(tab.id, { type: "probe" });
      } catch (error) {
        looked.push({ url: tab.url, note: "could not be read — reload it" });
        continue;
      }
      const score = scoreForms(reply.forms, state.plan);
      looked.push({ url: tab.url, score });
      if (!best || score > best.score) best = { score, forms: reply.forms, tab, url: tab.url };
      if (!host || score > 0) host = tab;
      if (reply.candidates && reply.candidates.length) {
        candidates = candidates.concat(reply.candidates);
      }
    }

    // The month grid holds an empty <form name="shift"> and opens the editor in
    // its own window, so what is on screen is usually not what we need. Read
    // the pages the grid links to, and anything the person named by hand.
    const manual = (state.settings.editUrl || "").trim();
    const toRead = (manual ? [manual] : []).concat(
      candidates.filter((url) => url !== manual)
    );
    if (host && toRead.length && (!best || !isComplete(best.forms, state.plan))) {
      for (const url of toRead.slice(0, manual ? 9 : 8)) {
        let reply;
        try {
          reply = await askTab(host.id, { type: "probeUrl", url });
        } catch (error) {
          looked.push({ url, note: "could not be fetched" });
          continue;
        }
        if (!reply.ok) {
          looked.push({ url, note: reply.detail || `HTTP ${reply.status}` });
          continue;
        }
        const score = scoreForms(reply.forms, state.plan);
        looked.push({ url, score, fetched: true });
        if (!best || score > best.score) {
          best = { score, forms: reply.forms, tab: host, url };
        }
        if (isComplete(reply.forms, state.plan)) break;
      }
    }
    if (!best) {
      throw new Error(
        "None of the open S4 tabs could be read. Reload the S4 page so the extension " +
          "loads into it, then try again."
      );
    }
    if (best.score === 0) {
      throw new Error(
        `Looked at ${looked.length} S4 page(s) and found no shift form. Open the shift ` +
          "edit window — the one with Category, Shift Time and Duration on it — or paste " +
          "its address into “editor page” below, then try again."
      );
    }

    const { forms, tab } = best;
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
      tabId: tab.id,
      tabUrl: best.url || tab.url,
      looked,
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
