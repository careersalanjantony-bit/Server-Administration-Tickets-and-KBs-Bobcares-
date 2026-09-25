/*
 * Runs the extension's background and content scripts outside Firefox.
 *
 * The real thing cannot be exercised here, so the two scripts are loaded into a
 * VM with a stand-in `browser` API, a stand-in DOM holding a form shaped like
 * S4's, and a fetch that records what was posted. That is enough to check the
 * parts that would actually corrupt a roster: the field mapping and the bodies.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");

const SLOT_LABELS = [
  "06:58am-02:58pm", "7:00am-3:00pm", "07:02am-03:02pm", "07:30am-03:30pm",
  "08:00am-04:00pm", "10:00am-06:00pm", "11:30am-07:30pm", "01:00pm-09:00pm",
  "02:58pm-10:58pm", "3:00pm-11:00pm", "03:02pm-11:02pm", "05:30pm-01:30am",
  "10:58pm-06:58am", "11:00pm-7:00am", "Flexy",
];
const CATEGORY_LABELS = [
  ["Working Day(W)", "W"], ["In Team Work(ITW)", "ITW"], ["Off", "OFF"],
  ["Casual Leave", "CL"], ["Medical Leave", "ML"], ["Public Holiday", "PH"],
];

function option(text, value) {
  return { value, textContent: text };
}

/** Which elements a CSS selector like "input[name], textarea[name]" asks for. */
function pick(selector, inputs, selects) {
  const out = [];
  if (/\binput\b|\btextarea\b/.test(selector)) out.push(...inputs);
  if (/\bselect\b/.test(selector)) out.push(...selects);
  return out;
}

/**
 * A stand-in for an S4 page.
 *
 * `loose` reproduces what the month grid actually does: an empty
 * <form name="shift"> with the controls rendered elsewhere in the document.
 */
function makeDocument(techIds, { selects = true, loose = false, noFields = false } = {}) {
  const inputs = noFields ? [] : [
    { name: "sdate", type: "text", value: "" },
    { name: "edate", type: "text", value: "" },
    { name: "stime_hr", type: "text", value: "" },
    { name: "stime_min", type: "text", value: "" },
    { name: "stime_ampm", type: "text", value: "" },
    { name: "dur_hr", type: "text", value: "" },
    { name: "dur_min", type: "text", value: "" },
    { name: "reason", type: "textarea", value: "" },
    { name: "log_reason", type: "textarea", value: "" },
    { name: "pw", type: "password", value: "hunter2" },
  ];
  const selectEls = selects && !noFields
    ? [
        { name: "category", options: CATEGORY_LABELS.map(([t, v]) => option(t, v)) },
        {
          name: "shift_time",
          options: SLOT_LABELS.map((label, i) => option(label, String(i + 1))),
        },
        { name: "staff", options: techIds.map((id, i) => option(id, String(200 + i))) },
      ]
    : [];

  const owned = loose ? { inputs: [], selects: [] } : { inputs, selects: selectEls };
  const form = {
    getAttribute(name) {
      return (
        { name: "shift", action: "index.php?action=view_shift", method: "POST" }[name] || null
      );
    },
    querySelectorAll(selector) {
      return pick(selector, owned.inputs, owned.selects);
    },
  };

  return {
    forms: [form],
    title: "S4",
    querySelectorAll(selector) {
      return pick(selector, inputs, selectEls);
    },
  };
}

function makeBrowser(tabs) {
  const store = {};
  const listeners = { background: [], content: [] };
  return {
    tabs: tabs || [{ id: 1, url: "https://s4.inhouse.net/index.php?action=view_shift&t=6" }],
    onAction: null,
    api(kind) {
      const self = this;
      return {
        runtime: {
          onMessage: { addListener: (fn) => listeners[kind].push(fn) },
          sendMessage: (message) => self.toBackground(message),
          getURL: (path) => `moz-extension://test/${path || ""}`,
          getManifest: () => ({ version: "test" }),
        },
        browserAction: { onClicked: { addListener: (fn) => (self.onAction = fn) } },
        windows: { update: async () => ({}) },
        storage: {
          local: {
            get: async (key) => (key in store ? { [key]: store[key] } : {}),
            set: async (obj) => Object.assign(store, obj),
          },
        },
        tabs: {
          // Honour the url filter the way the real API does, so a test can put
          // the extension's own page alongside S4's and check it is skipped.
          query: async (filter) => {
            const pattern = filter && filter.url;
            if (!pattern) return self.tabs;
            const rx = new RegExp(
              "^" + pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$"
            );
            return self.tabs.filter((tab) => rx.test(tab.url));
          },
          update: async (id) => {
            self.focused = id;
            return self.tabs.find((t) => t.id === id) || {};
          },
          create: async ({ url }) => {
            const tab = { id: self.tabs.length + 100, url };
            self.tabs.push(tab);
            return tab;
          },
          sendMessage: async (_id, message) => self.toContent(message),
        },
      };
    },
    async toBackground(message) {
      for (const fn of listeners.background) {
        const reply = fn(message);
        if (reply !== undefined) return reply;
      }
      return undefined;
    },
    async toContent(message) {
      for (const fn of listeners.content) {
        const reply = fn(message);
        if (reply !== undefined) return reply;
      }
      return undefined;
    },
  };
}

/**
 * @param {object} options
 *   techIds   - staff the S4 dropdown lists
 *   respond   - (body) => {status, text}; defaults to a bland success page
 *   selects   - false to simulate a page whose dropdowns are missing
 */
function load(options = {}) {
  const {
    techIds = [],
    respond = () => ({ status: 200, text: "<html><body>Shift updated</body></html>" }),
    selects = true,
  } = options;

  const bus = makeBrowser(options.tabs);
  const posted = [];
  const mappingSource = fs.readFileSync(path.join(ROOT, "content", "mapping.js"), "utf8");

  const contentContext = {
    console,
    URL,
    URLSearchParams,
    location: {
      href: "https://s4.inhouse.net/index.php?action=view_shift&t=6",
      origin: "https://s4.inhouse.net",
    },
    document: makeDocument(techIds, {
      selects,
      loose: options.loose,
      noFields: options.noFields,
    }),
    browser: bus.api("content"),
    setTimeout,
    async fetch(url, init) {
      const body = Object.fromEntries(new URLSearchParams(init.body));
      posted.push({ url, body });
      const reply = respond(body, posted.length);
      return { status: reply.status, text: async () => reply.text };
    },
  };
  contentContext.globalThis = contentContext;
  vm.createContext(contentContext);
  vm.runInContext(mappingSource, contentContext);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "content", "s4page.js"), "utf8"), contentContext);

  const backgroundContext = {
    console,
    browser: bus.api("background"),
    setTimeout,
    S4Mapping: contentContext.S4Mapping,
    Date,
    JSON,
    Promise,
  };
  backgroundContext.globalThis = backgroundContext;
  vm.createContext(backgroundContext);
  vm.runInContext(
    fs.readFileSync(path.join(ROOT, "background.js"), "utf8"),
    backgroundContext
  );

  return {
    posted,
    bus,
    // Values cross out of the VM, where they carry that context's prototypes and
    // compare unequal to identical host objects. Round-tripping them keeps the
    // assertions about the data rather than about which realm made it.
    send: async (type, extra) => {
      const reply = await bus.toBackground(Object.assign({ type }, extra || {}));
      return reply === undefined ? undefined : JSON.parse(JSON.stringify(reply));
    },
    S4Mapping: contentContext.S4Mapping,
  };
}

function samplePlan(overrides = {}) {
  return Object.assign(
    {
      month: "2026-10",
      form_name: "shift",
      slots: SLOT_LABELS.map((label, i) => ({ id: `s${i}`, label })),
      categories: {
        W: "Working Day", ITW: "In Team Work", OFF: "Off",
        CL: "Casual Leave", ML: "Medical Leave", PH: "Public Holiday",
      },
      techs: [
        { id: "mojin.t", display_name: "mojin.t", email: "mojin.t@poornam.com" },
        { id: "alan.j", display_name: "alan.j", email: "alan.j@poornam.com" },
      ],
      assignments: [
        {
          tech_id: "mojin.t", category: "W", slot_id: "s0",
          shift_time: "06:58am-02:58pm", start_date: "01-Oct-2026",
          end_date: "03-Oct-2026", days: 3, time: "06:58", duration_min: 480,
          reason: "Monthly roster autofill", source: "preference",
        },
        {
          tech_id: "alan.j", category: "W", slot_id: "s8",
          shift_time: "02:58pm-10:58pm", start_date: "01-Oct-2026",
          end_date: "02-Oct-2026", days: 2, time: "14:58", duration_min: 480,
          reason: "Monthly roster autofill", source: "minimum",
        },
      ],
    },
    overrides
  );
}

module.exports = { load, samplePlan, SLOT_LABELS };
