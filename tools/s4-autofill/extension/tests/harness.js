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
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));

/**
 * Load exactly the files the manifest declares, in the order it declares them.
 *
 * Handing a context a global it has not actually been given is how a missing
 * dependency hides: background.js used S4Mapping for weeks while the manifest
 * only loaded background.js, and these tests passed because the harness
 * injected it by hand.
 */
function loadDeclared(context, scripts) {
  scripts.forEach((relative) => {
    vm.runInContext(fs.readFileSync(path.join(ROOT, relative), "utf8"), context, {
      filename: relative,
    });
  });
}

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
function pick(selector, inputs, selects, clickables) {
  const out = [];
  if (/\binput\b|\btextarea\b/.test(selector)) out.push(...inputs);
  if (/\bselect\b/.test(selector)) out.push(...selects);
  if (/\[onclick\]|a\[href\]/.test(selector)) out.push(...(clickables || []));
  return out;
}

// S4's own popup(), as the month grid defines it. Every cell calls it with
// that cell's calendar row, and it opens the editor for exactly that row.
const POPUP_SOURCE =
  "var popupWin; function popup(cal_id,date,user,team,time,duration,cat_id," +
  "start_date,end_date,co_flag,comment, referer_team_id){ " +
  "// Set referer as current team if not set. Refs #120407\n" +
  "if(!referer_team_id) { referer_team_id = team; } " +
  'popupWin=window.open("index.php?action=chkshift&cal_id="+cal_id+"&cal_date="+date+' +
  '"&cal_user_id="+user+"&cal_team_id="+team+"&cal_time="+time+"&cal_duration="+duration+' +
  '"&cal_cat_id="+cat_id+"&sdate="+start_date+"&edate="+end_date+"&co_flag="+co_flag+' +
  '"&comment="+comment+"&referer_team_id="+referer_team_id,"shift","width=620,height=640"); }';

/** One calendar row per person per day of October, the way the grid holds them. */
function gridCellsFor(techIds, { month = "2026-10", days = 31, team = "6" } = {}) {
  const cells = [];
  techIds.forEach((_, t) => {
    for (let day = 1; day <= days; day += 1) {
      cells.push({
        cal_id: String(70000 + t * 100 + day),
        date: `${month}-${String(day).padStart(2, "0")}`,
        user: String(200 + t),
        team,
      });
    }
  });
  return cells;
}

function popupCall(cell) {
  return (
    `popup('${cell.cal_id}','${cell.date}','${cell.user}','${cell.team}','06:58','480','1',` +
    `'2026-10-01','2026-10-31','N','','')`
  );
}

/** Grid cells as elements carrying their onclick, plus the markup around them. */
function gridParts(cells) {
  const clickables = cells.map((cell) => ({
    getAttribute: (name) => (name === "onclick" ? popupCall(cell) : null),
  }));
  const html =
    `<script language="JavaScript"><!-- ${POPUP_SOURCE} //--></script>` +
    cells.map((cell) => `<td onclick="${popupCall(cell)}">W</td>`).join("");
  return { clickables, html };
}

/**
 * The editor S4 renders for one calendar row: its hidden fields filled in for
 * that row, and the dropdowns populated. `user` overrides whom it renders for,
 * and `calId` what it puts in the hidden cal_id — both are how a lookup gone
 * wrong would show.
 */
function makeEditorDocument(params, techIds, overrides = {}) {
  const calId = overrides.calId !== undefined ? overrides.calId : params.get("cal_id");
  const user = overrides.user !== undefined ? overrides.user : params.get("cal_user_id");
  const inputs = [
    { name: "cal_id", type: "hidden", value: calId },
    { name: "tid", type: "hidden", value: params.get("cal_team_id") || "" },
    { name: "view", type: "hidden", value: "month" },
    { name: "sdate", type: "text", value: "" },
    { name: "edate", type: "text", value: "" },
    { name: "stime_hr", type: "text", value: "" },
    { name: "stime_min", type: "text", value: "" },
    { name: "stime_ampm", type: "text", value: "" },
    { name: "dur_hr", type: "text", value: "" },
    { name: "dur_min", type: "text", value: "" },
    { name: "reason", type: "textarea", value: "" },
    { name: "log_reason", type: "textarea", value: "" },
    { name: "hcl_co", type: "checkbox", value: "B", checked: false },
    { name: "hcl_co", type: "checkbox", value: "NB", checked: false },
    { name: "shift_comment", type: "radio", value: "1", checked: true },
    { name: "shift_comment", type: "radio", value: "2", checked: false },
    { name: "Edit", type: "submit", value: "Edit" },
  ];
  const selects = [
    { name: "category", value: "W", options: CATEGORY_LABELS.map(([t, v]) => option(t, v)) },
    {
      name: "shift_time",
      value: "1",
      options: SLOT_LABELS.map((label, i) => option(label, String(i + 1))),
    },
    { name: "staff", value: user, options: techIds.map((id, i) => option(id, String(200 + i))) },
  ];
  const form = {
    getAttribute: (name) =>
      ({ name: "change_shift", action: "index.php?action=chkshift", method: "POST" }[name] ||
        null),
    querySelectorAll: (selector) => pick(selector, inputs, selects),
  };
  return {
    forms: [form],
    title: "S4",
    querySelectorAll: (selector) => pick(selector, inputs, selects),
  };
}

/**
 * A stand-in for an S4 page.
 *
 * `loose` reproduces what the month grid actually does: an empty
 * <form name="shift"> with the controls rendered elsewhere in the document.
 */
function makeDocument(
  techIds,
  { selects = true, loose = false, noFields = false, cells = gridCellsFor(techIds) } = {}
) {
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

  const grid = gridParts(cells || []);
  return {
    forms: [form],
    title: "S4",
    documentElement: { innerHTML: grid.html },
    querySelectorAll(selector) {
      return pick(selector, inputs, selectEls, grid.clickables);
    },
  };
}

/**
 * The month grid as S4 actually serves it: a team switcher, an empty
 * <form name="shift">, two date boxes, and links that open the editor in
 * another window. No Category, no Shift Time, no Duration.
 */
function makeGridDocument(editUrls, cells) {
  const urls = Array.isArray(editUrls) ? editUrls : [editUrls];
  const grid = gridParts(cells || []);
  const inputs = [
    { name: "sdate", type: "text", value: "01-Oct-2026" },
    { name: "edate", type: "text", value: "31-Oct-2026" },
  ];
  const selects = [
    { name: "team", options: [option("Select", ""), option("Installation", "6")] },
  ];
  const shiftForm = {
    getAttribute: (name) =>
      ({ name: "shift", action: "index.php?action=view_shift", method: "POST" }[name] || null),
    querySelectorAll: () => [],
  };
  const teamForm = {
    getAttribute: (name) =>
      ({ name: "team_change", action: "index.php?action=team_change", method: "POST" }[name] ||
        null),
    querySelectorAll: (selector) => pick(selector, [], selects),
  };
  return {
    forms: [teamForm, shiftForm],
    title: "S4",
    documentElement: {
      innerHTML:
        `<a href="index.php?action=view_shift&amp;t=6&amp;y=2026&amp;m=10">Oct</a>` +
        urls.map((url) => `<td onclick="window.open('${url}')">shift</td>`).join("") +
        grid.html +
        `<a href="index.php?action=log">Log</a>`,
    },
    querySelectorAll: (selector) => pick(selector, inputs, selects, grid.clickables),
  };
}

function makeBrowser(tabs, storage) {
  const store = Object.assign({}, storage || {});
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
 *   cells     - the grid's calendar rows; false for a page without any
 *   editors   - false when no row's editor can be opened
 *   editor    - (params, techIds) => document, to render a row's editor oddly
 */
function load(options = {}) {
  const {
    techIds = [],
    respond = () => ({ status: 200, text: "<html><body>Shift updated</body></html>" }),
    selects = true,
  } = options;

  const bus = makeBrowser(options.tabs, options.storage);
  const cells =
    options.cells === false ? [] : options.cells || gridCellsFor(techIds);
  const posted = [];
  const fetched = [];

  const contentContext = {
    console,
    URL,
    URLSearchParams,
    // A real URL rather than a hand-made object: location.hostname was missing
    // from the stub, so every discovered link looked cross-origin and was
    // dropped — a gap in the fixture, invisible in the product.
    location: new URL("https://s4.inhouse.net/index.php?action=view_shift&t=6"),
    document: options.grid
      ? makeGridDocument(options.grid, cells)
      : makeDocument(techIds, {
          selects,
          loose: options.loose,
          noFields: options.noFields,
          cells,
        }),
    browser: bus.api("content"),
    setTimeout,
    async fetch(url, init) {
      if (!init || !init.body) {
        // a page read, not a post
        const page = options.pages && options.pages[url];
        fetched.push(url);
        if (page) return { status: 200, text: async () => page };
        // A real row's editor, as popup() would have opened it.
        if (options.editors !== false && /[?&]cal_id=\d+/.test(url) && /chkshift/.test(url)) {
          return { status: 200, text: async () => `EDITOR ${url}` };
        }
        return { status: 404, text: async () => "<html>Not found</html>" };
      }
      const body = Object.fromEntries(new URLSearchParams(init.body));
      posted.push({ url, body });
      const reply = respond(body, posted.length);
      return { status: reply.status, text: async () => reply.text };
    },
    DOMParser: function DOMParserStub() {
      return {
        parseFromString(html) {
          if (html.startsWith("EDITOR ")) {
            const params = new URL(html.slice(7)).searchParams;
            return (options.editor || makeEditorDocument)(params, techIds);
          }
          // The pages map hands back a ready-made document rather than html,
          // so parsing is a lookup. Enough to exercise the fetch-and-read path.
          return options.documents && options.documents[html]
            ? options.documents[html]
            : { forms: [], querySelectorAll: () => [] };
        },
      };
    },
  };
  contentContext.globalThis = contentContext;
  vm.createContext(contentContext);
  loadDeclared(contentContext, MANIFEST.content_scripts[0].js);

  // The globals a real background page has. Leaving one out does not make the
  // product wrong, it makes the fixture lie — which is how the missing
  // S4Mapping went unnoticed.
  const backgroundContext = {
    console,
    browser: bus.api("background"),
    setTimeout,
    setInterval,
    clearTimeout,
    clearInterval,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    Date,
    JSON,
    Promise,
    Math,
    Set,
    Map,
  };
  backgroundContext.globalThis = backgroundContext;
  vm.createContext(backgroundContext);
  loadDeclared(backgroundContext, MANIFEST.background.scripts);

  return {
    posted,
    fetched,
    bus,
    // Values cross out of the VM, where they carry that context's prototypes and
    // compare unequal to identical host objects. Round-tripping them keeps the
    // assertions about the data rather than about which realm made it.
    send: async (type, extra) => {
      const reply = await bus.toBackground(Object.assign({ type }, extra || {}));
      return reply === undefined ? undefined : JSON.parse(JSON.stringify(reply));
    },
    S4Mapping: contentContext.S4Mapping,
    backgroundGlobals: backgroundContext,
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

module.exports = {
  load, samplePlan, makeDocument, makeEditorDocument, gridCellsFor, POPUP_SOURCE, SLOT_LABELS,
};
