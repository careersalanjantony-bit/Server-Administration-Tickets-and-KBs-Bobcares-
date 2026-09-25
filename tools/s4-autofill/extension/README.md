# S4 Shift Autofill — Firefox extension

Applies a planned month to S4 from inside your browser.

S4 is only reachable on the internal network, so nothing outside it can post to
it. This runs as a content script on the S4 page itself, using the session you
are already logged in with — no credentials to store anywhere, no network
access needed from the planner.

Same shape as BugCounter: Firefox WebExtension, Manifest V2, `browser.*` APIs,
a background script, a popup and a content script.

---

## Install

For everyday use, load it unsigned:

1. Open `about:debugging#/runtime/this-firefox`
2. **Load Temporary Add-on…** → pick `manifest.json` in this folder
3. It stays loaded until Firefox restarts

To keep it across restarts, run `./build.sh` and get the `.xpi` signed at
addons.mozilla.org under **Submit a New Add-on → On your own**, the same route
the existing in-house extension went through.

---

## Using it

```bash
# in tools/s4-autofill — produces out/2026-11/plan.json
python3 -m s4autofill import-form 'November off form submissions.xlsx' \
    --month 2026-11 --apply-notes --save
python3 -m s4autofill plan --month 2026-11
```

Then, in Firefox:

1. Log in to S4 and open the shift page for the month you are filling.
2. Click the toolbar button. It opens the extension in its **own tab** —
   leave the S4 tab where it is.
3. **Load the plan** — pick `out/2026-11/plan.json`, drag it onto the box, or
   paste its contents.
4. **Find the shift form** — it works out which dropdown option is which shift,
   category and tech, and tells you what it could not match.
5. **Dry run** — sends nothing at all, no matter which month you are on.
   Check the list.
6. **Fill S4 for real** — tick **Allow writing to S4** first, since writing is
   locked on a fresh install. It then asks you to confirm, and posts with a
   progress bar and a Stop button.

### Which month gets written

The dates in each post decide that, not the page you are looking at. A post
carries its own `sdate`/`edate`, so loading December's plan writes December
even while you are looking at October. If the page it found is showing a
different month from the plan, the popup says so — that usually means the
wrong plan got loaded.

This is also why a dry run is safe on any month: it builds the bodies and sends
none of them.

### Which page to be on

It does not matter much, which is deliberate. S4 spreads this over two windows:
the month grid carries an empty `<form name="shift">` with the controls
rendered loose in the document, and the edit popup carries a normal form. The
probe checks **every open S4 tab**, sweeps up named fields whether or not they
sit inside a `<form>`, and keeps whichever page has the real thing — then shows
you which one it picked.

If it cannot find a shift form anywhere, it says so rather than guessing: open
the shift edit window (the one with Category, Shift Time and Duration on it)
and probe again.

The UI is a tab rather than a browser_action popup, because Firefox closes a
popup the moment it loses focus — and opening the file picker does exactly
that, so the plan never finished loading. The tab can be closed mid-run
regardless: the run lives in the background script and carries on.

---

## How it fills

Each row of the plan is one shift block — a person, a shift time and a run of
dates, because S4's form takes a start and end date. A 31-day month for 28
people is about 530 posts rather than 870.

It posts with `fetch` rather than submitting the form element. A real submit
reloads the page and tears down the script halfway through the run; a
same-origin `fetch` sends the identical form-encoded body, carries the session
cookie, and leaves the run intact.

The mapping is not hard-coded. The slot labels in the planner's `shifts.json`
were transcribed from S4's own column headers, so they match its dropdown text
directly — including S4's inconsistent leading zeros (`7:00am-3:00pm` in one
column, `07:02am-03:02pm` in the next), which is why times are compared on
parsed values rather than as strings.

Each row shows why that person got that shift — `preference`, `minimum`,
`division-min`, `reassigned`, `flexy` — so the preference reasoning stays
visible while it fills.

---

## What stops it hurting anything

It writes to a live roster, so:

- **Writing is locked until you ask for it.** A fresh install refuses a live
  run outright; dry runs work regardless. Only one month is ever unlocked in
  S4, so a mis-click on the live button would land in a roster people are
  working to.
- **Dry run is the default** and posts nothing at all.
- **A live run is refused** while any field, shift time or category is
  unmatched. It names what is missing rather than guessing.
- **The live button asks for confirmation**, naming the month and the count.
- **It stops itself after 3 failures** — if the mapping or the session is
  wrong, it fails 3 times, not 530.
- **Stop halts the run** between posts.
- **An error page counts as a failure.** S4 answers with rendered HTML rather
  than a useful status code, so the response is scanned for the words it uses
  when something went wrong; a "success" that says "invalid" is reported red.
- **Nothing runs on page load.** Every action needs a click.
- **Password field values are never read out of the page**, even though the
  probe reads every other field.

---

## Tests

```bash
node --test
```

37 tests. They load the real `background.js` and `content/s4page.js` into a VM
with a stand-in `browser` API and a form shaped like S4's, and cover the things
that would actually corrupt a roster: that duration fields are never mistaken
for the clock fields, that midnight and noon do not post as hour zero, that a
dry run sends nothing, that an incomplete mapping blocks a live run, that error
pages are not counted as successes, that Stop actually stops, that the month
written comes from the plan's dates rather than the page, and that both of S4's
page layouts produce byte-identical POST bodies, that a loaded plan is still
there on the next read, and that the extension's own page is never mistaken
for S4.

The real October plan — 534 blocks, 868 tech-days — runs through the harness
with all 15 shift times, all 28 staff and all 12 fields mapped, and nothing
left over.

---

## What has not been tested

The real S4. I have never been able to reach it, so the form here is a stand-in
built from screenshots of the edit popup. The field names and dropdown values
are discovered at runtime rather than assumed, which is what makes that
survivable — but **do the dry run first**, and read what it says it will post
before letting it write anything.
