# Bob_Portal Server Audit Autofill

Automates the repetitive half of filling in a server audit on the Bob_Portal
checklist: it turns `cpanel-audit.sh` output into the ~38 checklist entries and
fills each modal for you. **You still review and submit every item yourself —
nothing here ever clicks Submit.**

Filling one server by hand means opening ~38 modals, picking Active/Inactive,
typing the notes, and answering the recommendation question in each. This does
the typing; you do the judging.

---

## Why an extension and not a console snippet

Submitting an audit item is a classic POST → redirect → GET: the whole page
reloads after every Submit, which wipes all page JavaScript — variables,
functions, progress counter, everything. A pasted console script therefore
cannot survive past the first item, and no amount of event-listening or
`MutationObserver` work changes that, because the script itself no longer
exists after the reload.

A content script re-runs automatically on every page load and keeps its
progress in `browser.storage.local`, which reloads do not touch. That is the
only shape that works here.

---

## Layout

```
extension/            the Firefox add-on (load this in Firefox)
  manifest.json
  content.js          runs on the audit edit page; opens + fills the next item
  popup.html/.js      paste the report here; shows what was parsed
  lib/rules.js        report label -> checklist item mapping  <- edit this one
  lib/parser.js       report text -> AUDIT_DATA (shared with the CLI)
bin/parse-audit-report.js   same parser as a CLI, for piping off a server
samples/report-detailed.log sanitised example report
tests/                parser tests + a real-browser test of the content script
run-tests.sh
```

`lib/parser.js` and `lib/rules.js` are used by both the popup and the CLI, so
the parsing rules only exist in one place.

---

## Install (Firefox)

1. Copy the `extension/` folder to the machine you run Firefox on.
2. Go to `about:debugging#/runtime/this-firefox`.
3. **Load Temporary Add-on…** → select `extension/manifest.json`.

It stays loaded until Firefox fully restarts; repeat the steps after a restart.
To install it permanently, package and sign it through
[addons.mozilla.org](https://addons.mozilla.org/developers/) — the add-on ID is
`server-audit-autofill@bobcares.local`.

---

## Use

1. Run your audit script on the server and copy the report
   (`report-detailed.log` / `audit-smart-summary.md`).
2. Open the audit edit page:
   `portal.bobcares.com/bob_Portal/server-audit/<client>/edit/<audit>`
3. Click the extension's toolbar icon (it may be under the puzzle-piece menu).
4. Paste the report straight into the textarea — raw report text is fine, it
   does not need to be JSON.
5. Click **Preview** to see what it understood: how many items resolved, which
   came back inactive, and which it is leaving blank for you.
6. Click **Save & start from item 1**. The page reloads and item 1 opens,
   filled in.
7. Check the modal, click **Submit** yourself. The page reloads and the next
   item opens filled in. Repeat.

The banner in the top-right shows which item you are on, plus **Back**,
**Skip**, **Mark done** and **Pause**.

Progress is stored per audit (keyed on the client and audit IDs in the URL), so
you can work on several servers without them interfering.

### Command line instead

If you would rather build the JSON on the server:

```bash
# from this directory
node bin/parse-audit-report.js samples/report-detailed.log --summary
node bin/parse-audit-report.js report-detailed.log > audit-data.json
ssh root@server 'bash cpanel-audit.sh' | node bin/parse-audit-report.js
```

Flags: `--summary` (readable breakdown), `--unmapped` (report lines nothing
consumed), `--strict` (exit 1 if anything is unresolved), `--compact`.

The JSON it prints pastes into the popup exactly like the raw report does.

---

## How the parsing works

The audit script has already made the judgement call on each check — `Good`,
`Warning`, `Disabled`, `Update Available` and so on. The parser does not
re-assess the server; it translates those verdicts into the portal's fields:

| Report line | Portal result |
|---|---|
| `System Firewall : Good - Active: iptables nftables` | Active, details `Active: iptables nftables` |
| `Web App Firewall : Warning - Rules Engine is unknown` | Inactive + recommendation |
| `PHP pending : 0` | Active, `No updates pending.` |
| `Control panel : Update Available (Installed: … Latest: …)` | Inactive + recommendation |
| `OS / Version : cloudlinux 8.10 (Supported)` | Active (verdict read from the parentheses) |
| `Reboot required : Yes (Core components updated…)` | Inactive — "yes" is inverted for this check |

Recommendation text (issue / recommendation / service hours) is attached only
when an item comes back inactive, from the templates in `lib/rules.js`.

**Anything it cannot read is left blank, not guessed.** An item whose report
line is missing, or whose value contains no verdict it recognises, is reported
as needing manual entry and skipped during autofill. A wrong status in a
customer's audit is worse than an empty one.

### Same-titled checklist items

"Control Panel", "Operating System" and "CMS" each appear twice — once under
Software Updates and once under Software Life Time. Items carry an
`occurrence` (0 = first modal with that title in DOM order, 1 = second), and
the banner warns you whenever it had to disambiguate, so you can confirm it
picked the right one. An explicit `"modalId": "subcategory_51"` in the data
overrides the guess.

---

## Adapting it when the audit script changes

Everything site-specific lives in `lib/rules.js` — no parser changes needed:

* **A report label changed** → add it to that item's `sources` list.
* **A verdict word is unrecognised** → add it to `verdicts.active` or
  `verdicts.inactive`. Longer phrases win over shorter ones, so
  `not configured` is never mistaken for `no`.
* **A check where "Yes" is bad** → use `{ label: "…", interpret: "invert" }`.
* **A numeric count where 0 is good** → `interpret: "count-zero-good"`.
* **A new checklist item** → add it to the right section with its `category`,
  `titleAliases` and `sources`.

Run `node bin/parse-audit-report.js <report> --unmapped` to list every report
line that no checklist item consumed — that is the working list when wiring up
a new audit-script version.

### Coverage note

The mapping is built against a full report covering all six sections plus
Additional cPanel Checks (see `samples/report-detailed.log`), which resolves
**35 of the 38** checklist items.

The three it leaves for you are cases where the audit script itself reports
that it could not determine the answer, so there is nothing to translate:

| Item | Report line |
|---|---|
| Software Updates / CMS | no CMS update line is emitted at all |
| Software Life Time / CMS | `CMS : Manual check required` |
| Proactive Defence / Reboot Procedure | `Reboot Procedure : Manual - confirm hypervisor console reboot access is documented` |

Turning "the script does not know" into a status would be inventing a finding,
so those stay blank and are listed for you in the Preview.

---

## Safety properties

* **It never submits.** No code path activates a submit control; the browser
  test asserts this after every step.
* **It never advances past an item it did not see saved.** By default it waits
  for the page's success flash before moving on, so cancelling a modal does not
  silently skip that item. (A popup checkbox switches to advancing immediately
  if you prefer the faster loop.)
* **It only runs on the audit edit page** — the host permission and content
  script are both scoped to
  `https://portal.bobcares.com/bob_Portal/server-audit/*/edit/*`.
* **It sends nothing anywhere.** No network calls, no telemetry; the report
  text and progress stay in local extension storage.

---

## Tests

```bash
./run-tests.sh
```

* `tests/parser.test.js` — 35 checks over verdict reading, section-scoped label
  lookup, the interpreters, and the "report it, don't guess it" behaviour.
* `tests/content.e2e.test.js` — 25 checks driving the real content script in
  Chromium against a mock of the portal page (`tests/fixtures/audit-page.html`)
  that reproduces its structure: `subcategory_NN` modals, the duplicated
  `#comment` id, the recommendation block that only appears after "Yes", and a
  submit button the test fails on if it is ever clicked. Storage is stubbed
  through to Node so progress survives reloads, which is the behaviour under
  test.

The browser suite skips itself with exit 0 if Playwright is not installed.
