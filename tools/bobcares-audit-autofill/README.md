# Bobcares Audit Autofill (Firefox extension)

Fills in a new Bobcares server audit (`portal.bobcares.com/bob_Portal/server-audit/<server>/edit/<audit>`) from a **screenshot of the previous audit**:

1. You give it a screenshot of last month's **View Server Audit** page.
2. It reads every row of every section: green ✓, red ✗, grey NA.
3. It lists the items of the new audit with the ones that were **green ✓** ticked, so you can check them.
4. For each ticked item it opens the edit dialog, picks **Active**, and presses **Submit**.

Everything that wasn't green (✗, NA, not done) is **left as it is**. In the dialog only the Active/Inactive choice is changed; *Additional details* and *Any recommendations?* are not touched.

## Install (Firefox)

**For a quick try (removed when Firefox restarts):**

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…** and select `tools/bobcares-audit-autofill/manifest.json`.
3. Pin the **Audit Autofill** icon from the extensions (puzzle) menu.

**To keep it installed:** release Firefox only accepts signed add-ons. Either

- sign it yourself as an *unlisted* (private) add-on:
  `npx web-ext sign --channel=unlisted --source-dir tools/bobcares-audit-autofill --ignore-files "test/**" --api-key=… --api-secret=…`
  (you get the API keys from addons.mozilla.org → Developer Hub → Manage API Keys), then open the `.xpi` it creates in Firefox, or
- use Firefox Developer Edition / Nightly, set `xpinstall.signatures.required` to `false` in `about:config`, zip the folder contents and install the zip from `about:addons` → ⚙ → *Install Add-on From File…*.

## Use

1. **Take the reference screenshot.** Open the previous month's audit (*View Server Audit*, `…/server/<id>/audits/<audit>`). Zoom out (Ctrl + -, 50% works well) until all six section cards are visible, then take a screenshot: Firefox right-click → **Take Screenshot** → *Save visible* (or *Copy*), or your system's screenshot tool. PNG is best.
2. **Open the new audit**, the edit page with the green edit buttons. A green **✓ Audit Autofill** button appears at the bottom-right (or click the toolbar icon → *Open the panel on this page*).
3. In the panel, **drop the screenshot**, **paste** it (Ctrl+V), or click the box to choose the file.
4. **Check the list.** The preview shows what was read: each section is outlined and numbered, and every icon has a ring in the colour it was read as (green ✓, red ✗, grey NA). Click the preview to enlarge it. Below it, each item of this page has:
   - a checkbox, ticked when the item was ✓ in the screenshot (untick anything you don't want, or use *all* / *none* per section)
   - a dot with its colour on this page now
   - a chip with what the screenshot shows (✓ / ✗ / NA)
5. Optional: **Highlight** outlines the ticked rows on the page. **Dry run** opens each ticked item and picks Active, then presses *Cancel*, so nothing is saved. Use it the first time to see that it works with your portal.
6. Press **Mark N items Active**. The panel shows each item as it goes: *marked*, *skipped*, *check* or *failed*. **Stop** halts it after the current item.

If Submit reloads the page, the run carries on by itself after the reload. If the portal sends you to a different page after saving, the extension goes back to the audit and continues.

## How it reads the screenshot

No OCR and no internet. The screenshot is read inside your browser:

- The **blue header bars** give the sections. They are numbered in reading order (top row left to right, then the next row), the same order as the cards on the edit page.
- In each card, the **eye icons** give the rows. The icon just left of the eye gives the status, from its colour: green → ✓, red → ✗, grey → NA, yellow → not done.
- A screenshot of a filled-in **edit page** also works. There the coloured dot left of each label is read.

Rows are matched to the page **by position**: 3rd row of the 2nd section → 3rd item of the 2nd section. The labels come from the page. Two safety checks:

- If a section has a **different number of rows** in the screenshot than on the page, nothing in that section is ticked, and the panel says so. Tick items yourself if they are right.
- Items that are **already green** on the page are not ticked (*already active*). You can turn this off in Settings.

Any zoom level works. Heavily compressed JPEGs (for example, sent through a chat app) can wash out the small ✓ icons. They are then read as NA and left alone, and the panel warns you. Use a PNG screenshot.

## Settings

In the panel, under **Settings** (saved for next time):

| Setting | Default | What it does |
|---|---|---|
| Names of the green option | `Active, Enabled` | The dialog option that is picked. If your dialog says something else, add it here. An item whose dialog has none of these names fails and is left unchanged. |
| Wait between items | 800 ms | Pause after each item. |
| Skip items that are already green | on | Doesn't re-submit items that already show green on the page. |
| Text for "Additional details" | empty | Typed into *Additional details* only when that box is empty. Leave blank to never touch it. |

## If something doesn't work

- **"No audit items found on this page"**: open the audit *edit* page (the one with the edit buttons), wait for it to load, then press **Rescan page**.
- **A section shows a row-count mismatch**: the screenshot may be cut off or overlapped (a tooltip over the icons, for example). Take it again with all cards fully visible.
- **"no "Active" option in the dialog (found: …)"**: add the right word from the list in *found:* to the green option names in Settings.
- **"the dialog stayed open after Submit"**: the portal rejected the form, and its message is shown. The dialog is closed and the run moves on to the next item.

## Files

| File | Purpose |
|---|---|
| `manifest.json` | Extension manifest (Manifest V2, which Firefox fully supports). Runs only on `portal.bobcares.com`. |
| `analyzer.js` | Reads the screenshot (sections, rows, ✓ / ✗ / NA) and pairs it with the page's items. Pure functions, shared by the page script and the tests. |
| `page.js` | Finds the audit items on the edit page, and opens / fills / submits an item's dialog. |
| `content.js` | The panel on the page, and the run (kept in `browser.storage.local` so it survives page reloads). |
| `popup/` | Toolbar popup: opens the panel on the current tab. |
| `test/analyzer.test.js` | Unit tests on drawn screenshots: `node --test tools/bobcares-audit-autofill/test/analyzer.test.js` |
| `test/e2e.test.js`, `test/mock/` | End-to-end test in Chromium against mock audit pages (two page layouts, with and without page reloads). Needs Playwright: `NODE_PATH="$(npm root -g)" node --test tools/bobcares-audit-autofill/test/e2e.test.js`. Set `AUDIT_REFERENCE=/path/to/screenshot.png` to use a real View Server Audit screenshot as the reference. |

The screenshot never leaves your browser. The extension stores only its settings and the progress of a running fill-in in the add-on's local storage.
