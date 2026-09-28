#!/usr/bin/env node
/**
 * End-to-end test for the content script, driven against a mock of the portal
 * page (tests/fixtures/audit-page.html) in a real browser.
 *
 *   node tests/content.e2e.test.js
 *
 * Needs Playwright. If it is not installed the test reports SKIPPED and exits
 * 0, so `run-tests.sh` still passes on a machine without a browser.
 *
 * The extension storage API is stubbed by bindings back into Node, so the
 * stored progress survives the page reloads the script triggers - which is
 * the whole behaviour under test.
 */
"use strict";

const fs = require("fs");
const path = require("path");

let chromium;
try {
  chromium = require("playwright").chromium;
} catch (e) {
  try {
    chromium = require(path.join(
      process.env.NODE_PATH || "/opt/node22/lib/node_modules",
      "playwright"
    )).chromium;
  } catch (e2) {
    process.stdout.write("SKIPPED (playwright not installed)\n");
    process.exit(0);
  }
}

const ROOT = path.join(__dirname, "..");
const PAGE_URL = "https://portal.bobcares.com/bob_Portal/server-audit/5506/edit/12097";
const STORAGE_KEY = "audit:5506:12097";
const CONTENT_JS = fs.readFileSync(path.join(ROOT, "extension", "content.js"), "utf8");
const FIXTURE = fs.readFileSync(path.join(__dirname, "fixtures", "audit-page.html"), "utf8");

let passed = 0;
const failures = [];

function check(name, cond, extra) {
  if (cond) passed++;
  else failures.push(name + (extra ? " (" + extra + ")" : ""));
}

/* ------------------------------------------------------- mock page markup */

/**
 * Reproduces the structure confirmed from the real page's DOM dump:
 * a div#subcategory_NN per item, a .card-title header, sub_category-value
 * radios (1 = Active, -1 = Inactive), a textarea#comment, recommendation-status
 * radios, and a hidden recommendation-div-NN with Issue / Recommendation /
 * Service hours. Note #comment is duplicated across modals, exactly as in the
 * real page.
 */
function modalHtml(n, title) {
  return `
    <div class="modal fade" id="subcategory_${n}" role="dialog">
      <div class="modal-dialog"><div class="modal-content">
        <div class="modal-header"><h4 class="card-title">${title}</h4></div>
        <form id="audit-add-form-${n}" method="POST" action="/bob_Portal/server-audit/5506/new/12097/${n}">
          <input type="hidden" name="_token" value="mock-csrf-token" />
          <label><input type="radio" name="sub_category-value" value="1" /> Active</label>
          <label><input type="radio" name="sub_category-value" value="-1" /> Inactive</label>
          <label for="comment">Additional details</label>
          <textarea id="comment" name="comment"></textarea>
          <label><input type="radio" name="recommendation-status" value="1" /> Yes</label>
          <label><input type="radio" name="recommendation-status" value="-1" /> No</label>
          <div class="rec-block" id="recommendation-div-${n}">
            <label for="issue-${n}">Issue</label>
            <textarea id="issue-${n}" name="issue"></textarea>
            <label for="rec-${n}">Recommendation</label>
            <textarea id="rec-${n}" name="recommendation-text"></textarea>
            <label for="hours-${n}">Service hours</label>
            <input type="number" id="hours-${n}" name="service-hours" />
          </div>
          <button type="submit">Submit</button>
        </form>
      </div></div>
    </div>`;
}

const MODALS = [
  [11, "System Firewall"],
  [12, "Malware Scanner"],
  [13, "Web App Firewall"],
  [21, "Control Panel"],      // Software Updates
  [51, "Control Panel"]       // Software Life Time - same title, second in DOM order
]
  .map(function (m) { return modalHtml(m[0], m[1]); })
  .join("\n");

function pageHtml(withSuccessFlash) {
  return FIXTURE.replace("<!--MODALS-->", MODALS).replace(
    "<!--SUCCESS_FLASH-->",
    withSuccessFlash
      ? '<div class="alert alert-success">Success! Audit added successfully</div>'
      : ""
  );
}

/* ------------------------------------------------------------------ items */

const ITEMS = [
  {
    section: "Threat Protection",
    category: "System Firewall",
    titleAliases: ["System Firewall"],
    occurrence: 0,
    status: "active",
    details: "Active: iptables nftables firewalld Imunify360 | Inactive: cPHulk",
    recommendation: null
  },
  {
    section: "Threat Protection",
    category: "Web App Firewall",
    titleAliases: ["Web App Firewall"],
    occurrence: 0,
    status: "inactive",
    details: "Rules Engine is unknown",
    recommendation: {
      issue: "ModSecurity rules engine status is unclear.",
      recommendation: "Enable and configure ModSecurity with an active rule set.",
      hours: 1
    }
  },
  {
    section: "Software Life Time",
    category: "Control Panel",
    titleAliases: ["Control Panel"],
    occurrence: 1, // must pick subcategory_51, not subcategory_21
    status: "inactive",
    details: "cPanel 11.136.0.40 approaching end of life",
    recommendation: null
  }
];

/* ------------------------------------------------------------------- main */

(async function () {
  const browser = await chromium.launch();
  const context = await browser.newContext();

  // Storage lives in Node so it survives the reloads the script performs.
  const store = {};
  await context.exposeFunction("__storeGet", function (key) {
    const out = {};
    if (key in store) out[key] = store[key];
    return out;
  });
  await context.exposeFunction("__storeSet", function (obj) {
    Object.keys(obj).forEach(function (k) { store[k] = obj[k]; });
    return true;
  });
  await context.exposeFunction("__storeRemove", function (key) {
    delete store[key];
    return true;
  });

  // Re-installed on every navigation, like a real WebExtension API would be.
  await context.addInitScript(function () {
    window.browser = {
      storage: {
        local: {
          get: function (key) { return window.__storeGet(key); },
          set: function (obj) { return window.__storeSet(obj); },
          remove: function (key) { return window.__storeRemove(key); }
        }
      }
    };
  });

  let serveSuccessFlash = false;
  await context.route("**/bob_Portal/server-audit/**", function (route) {
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: pageHtml(serveSuccessFlash)
    });
  });

  const page = await context.newPage();

  async function load() {
    await page.goto(PAGE_URL, { waitUntil: "domcontentloaded" });
    await page.addScriptTag({ content: CONTENT_JS });
    await page.waitForTimeout(600);
  }

  // ---- item 1 ------------------------------------------------------------
  store[STORAGE_KEY] = {
    items: ITEMS,
    cursor: 0,
    pending: null,
    unconfirmed: 0,
    paused: false,
    confirmMode: "confirmed"
  };

  await load();

  check(
    "opens the first item's modal",
    await page.locator("#subcategory_11").evaluate(function (el) {
      return el.classList.contains("show");
    })
  );
  check(
    "sets the Active radio",
    await page.locator('#subcategory_11 input[name="sub_category-value"][value="1"]').isChecked()
  );
  check(
    "fills the details textarea",
    (await page.locator("#subcategory_11 textarea#comment").inputValue()).indexOf("iptables") !== -1
  );
  check(
    "sets recommendation to No when there is none",
    await page.locator('#subcategory_11 input[name="recommendation-status"][value="-1"]').isChecked()
  );
  check(
    "leaves other modals untouched",
    (await page.locator("#subcategory_12 textarea#comment").inputValue()) === "",
    "duplicate #comment id must not leak across modals"
  );
  check("shows the progress banner", await page.locator("#bobcares-audit-autofill-banner").isVisible());
  check(
    "banner names the item",
    (await page.locator("#bobcares-audit-autofill-banner").textContent()).indexOf("System Firewall") !== -1
  );
  check("never clicks Submit", (await page.evaluate(function () { return window.__submitted; })).length === 0);
  check("records the item as pending", store[STORAGE_KEY].pending === 0, "pending=" + store[STORAGE_KEY].pending);

  // ---- no save confirmation: must NOT advance ----------------------------
  await load();
  check(
    "does not advance when the save was not confirmed",
    store[STORAGE_KEY].pending === 0,
    "pending=" + store[STORAGE_KEY].pending
  );
  check(
    "re-fills the same item instead of skipping it",
    await page.locator('#subcategory_11 input[name="sub_category-value"][value="1"]').isChecked()
  );

  // ---- save confirmed: advance to item 2 ---------------------------------
  serveSuccessFlash = true;
  await load();

  check("advances after a confirmed save", store[STORAGE_KEY].pending === 1, "pending=" + store[STORAGE_KEY].pending);
  check(
    "opens the second item's modal",
    await page.locator("#subcategory_13").evaluate(function (el) {
      return el.classList.contains("show");
    })
  );
  check(
    "sets the Inactive radio",
    await page.locator('#subcategory_13 input[name="sub_category-value"][value="-1"]').isChecked()
  );
  check(
    "sets recommendation to Yes",
    await page.locator('#subcategory_13 input[name="recommendation-status"][value="1"]').isChecked()
  );
  check(
    "reveals and fills the Issue field",
    (await page.locator("#issue-13").inputValue()).indexOf("ModSecurity") !== -1
  );
  check(
    "fills the Recommendation field",
    (await page.locator("#rec-13").inputValue()).indexOf("Enable and configure") !== -1
  );
  check("fills Service hours", (await page.locator("#hours-13").inputValue()) === "1");

  // ---- duplicate titles: occurrence must pick the right modal ------------
  await load();
  check("advances to the third item", store[STORAGE_KEY].pending === 2, "pending=" + store[STORAGE_KEY].pending);
  check(
    "occurrence:1 opens the second same-titled modal",
    await page.locator("#subcategory_51").evaluate(function (el) {
      return el.classList.contains("show");
    })
  );
  check(
    "occurrence:1 does not fill the first same-titled modal",
    (await page.locator("#subcategory_21 textarea#comment").inputValue()) === ""
  );
  check(
    "warns that the title was ambiguous",
    (await page.locator("#bobcares-audit-autofill-banner").textContent()).indexOf("modals are titled") !== -1
  );

  // ---- completion --------------------------------------------------------
  await load();
  const finalBanner = await page.locator("#bobcares-audit-autofill-banner").textContent();
  check("reports completion", finalBanner.indexOf("all items done") !== -1, finalBanner.slice(0, 80));
  check(
    "never clicked Submit at any point",
    (await page.evaluate(function () { return window.__submitted; })).length === 0
  );

  // ---- items with no status are left alone -------------------------------
  store[STORAGE_KEY] = {
    items: [
      { section: "Backup", category: "Local", titleAliases: ["Local"], status: null, details: "", recommendation: null },
      ITEMS[0]
    ],
    cursor: 0,
    pending: null,
    unconfirmed: 0,
    paused: false,
    confirmMode: "confirmed"
  };
  serveSuccessFlash = false;
  await load();
  check(
    "skips an unresolved item and fills the next real one",
    await page.locator('#subcategory_11 input[name="sub_category-value"][value="1"]').isChecked()
  );

  await browser.close();

  if (failures.length) {
    process.stderr.write("\n" + failures.length + " test(s) failed:\n");
    failures.forEach(function (f) { process.stderr.write("  FAIL  " + f + "\n"); });
    process.stderr.write("\n" + passed + " passed, " + failures.length + " failed\n");
    process.exit(1);
  }
  process.stdout.write(passed + " browser tests passed\n");
})().catch(function (err) {
  process.stderr.write("e2e run failed: " + (err && err.stack ? err.stack : err) + "\n");
  process.exit(1);
});
