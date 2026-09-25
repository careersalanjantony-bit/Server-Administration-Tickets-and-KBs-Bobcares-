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
5. **Dry run** — sends nothing at all, no matter which month you are on, and
   works even before the form has been found. Check the list.
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

The month grid, and it will find the rest itself.

S4 does not put the shift editor on the grid. That page has a team switcher, an
empty `<form name="shift">` and the From/To date boxes — probing it alone
returns *"2 fields · 0 shift times · 0 categories · 0 staff"*. The editor opens
in its own window, and its url carries `edit_co_shift`.

So **Find the shift form** does three things in turn, stopping as soon as it has
a complete mapping:

1. Probes every open S4 tab.
2. **Writes the editor's address out** from the plan's month and team, since
   the shape is known —
   `index.php?action=view_shift&sdate=…&edate=…&t=…&edit_co_shift=N`. S4 opens
   the editor from javascript that assembles the url in pieces, so there is
   often no whole address in the markup to find.
3. Pulls whatever urls *are* in the grid's markup — links and `window.open(…)`
   calls alike — and reads those.
4. Failing all of that, reads whatever address you paste under *"the editor is
   on another page"*, which is tried first when set.

### Where the form actually is

`index.php?action=chkshift`, form `change_shift`. Its fields:

| What | S4's name |
|---|---|
| tech | `uid` (hidden) |
| category | `cat` |
| shift time | `shift_time` |
| dates | `sdate` / `edate` (plus `startday`/`startmonth`/`startyear` and the `end*` trio) |
| start time | `hour`, `minute`, `ampm` |
| duration | `duration_h`, `duration_m` |
| note | `comment` |

Two traps in that list. `duration_h` does **not** contain the substring
`dur_h`, so hint matching on that missed both duration fields. And
`shift_comment` is a group of seven radio buttons, not a text field, so
anything matching on "comment" has to check the control type first.

**Every block changes its own calendar row.** `cal_id` is per person per
day, and the month grid is the only place it comes from. Each cell calls

    popup(cal_id, date, user, team, time, duration, cat_id,
          start_date, end_date, co_flag, comment, referer_team_id)

and `popup()` opens `index.php?action=chkshift&cal_id=…&cal_date=…&cal_user_id=…`
with those values. So the probe reads every `popup(…)` call in the grid (the
open tab first, since that is where any javascript-drawn cells exist, then the
month grid fetched by address), keeps one cell per `cal_id`, and indexes them by
S4 user id and date. `popup()`'s own definition is read off the page too, so
the editor address is built the way S4 builds it, including its fallback of
`referer_team_id` to the cell's own team.

A run then does this for each block:

1. Find the cell for that person (their S4 user id) on the block's first day.
   No cell, or a cell with no row id, and the block is **skipped** — listed in
   the results, not counted as a failure, nothing sent.
2. Open that cell's editor, exactly as clicking it would.
3. Build the body from what that editor rendered — its `cal_id`, `tid`, `view`,
   `prv_caldate`, the ticked radios, each dropdown's current value — and
   overwrite only the fields being set.
4. Refuse the row if the editor came back without a `cal_id`, for a different
   user than the block is about, or without the category or shift time asked
   for. Otherwise post it to the editor form's own action.

A live run is refused outright if the grid's rows were never read. A dry run
opens the first five resolvable rows' editors (reading is harmless) so the
bodies it shows are what S4 would really get; the rest show their own row's
`cal_id` from the grid without being opened.

Read against a bare `chkshift&cal_id=`, S4 renders the editor with `cat` empty
and `shift_time` holding only Flexy. The probe therefore also opens one real
cell's editor, which is where the category and shift-time values come from.

Radios and checkboxes go back only when ticked. Echoing every one posted the
last of each group — `hcl_co=NB` and `shift_comment=2` on every row whether or
not either was selected.

### A post carries the whole form

`change_shift` has eighteen fields the mapping knows nothing about — `cal_id`,
`tid`, `view`, `prv_caldate`, the split date parts, `countdown`, the `Edit`
button. A classic PHP form expects everything it rendered to come back, and
`cal_id` in particular is how S4 knows which row is being changed. So a post
starts from the form's own hidden values and overwrites only the fields being
set. Password fields are never echoed.

Dates go back in the shape S4 rendered them: the visible box shows
`01-Oct-2026` while the hidden one holds `2026-10-01`, and guessing wrong
writes the wrong day silently.

### S4 spreads the form over several pages

There is no single page with everything on it. In practice:
`action=edit_timings` carries the shift-time dropdown and nothing else;
`action=add_shift` and `action=manage_shift` carry the staff list; the month
grid carries only the From/To dates.

So the probe reads every page it can reach and **merges** them. The page that
supplies the most of the fields a post needs is the one it posts to, and the
option values — staff ids, shift-time ids, category codes — are taken from
wherever they turned up, because those are S4's own database ids and mean the
same thing everywhere. A field name missing from the posting page is borrowed
from another. The log says which page gave what.

Picking a single best page did not work: scoring by how many things matched
chose the timings page, which matched fourteen shift times and could not post
anything, over `add_shift`, which had the staff list and the fields.

It reports which page it settled on, and lists anything it could not match
rather than guessing.

### The activity log

Everything the extension does is recorded, and shown at the bottom of the page:
which pages it read and what each scored, what the mapping came back with and
what it could not match, every refusal and why, and what S4 said to each post.
**Problems only** filters to warnings and errors. **Copy log** and **Download**
take it away as text.

A long run is summarised rather than transcribed — the first few posts, then
every fiftieth, then the last — so failures are never buried. Every row is in
the results table regardless. The log is capped at 1200 entries.

### Copy diagnostics

One button, and the clipboard holds everything needed to work out why something
did not fit: the build version, the plan's shape, the mapping, **the real field
names and dropdown options of every form it saw**, what is still unmatched,
every page it looked at, the settings, the last failures and the whole log. It
stays small enough to paste.

Reach for this instead of describing a problem.

### Watching a run

The status line under the buttons says what is happening: **Idle**, **Dry run
going**, **Filling S4**, **Finished** or **Stopped**, with the count, the
percentage, when it started, and the row in flight right now — who, which
dates, which shift. The results table fills in underneath as it goes, green
for accepted and red for refused, with S4's own words in the third column.
**Copy log** takes the lot to the clipboard.

If it ever says a run is going when nothing is, **clear run state** appears
next to the status and resets it. That flag is also cleared automatically
whenever the extension starts, since a background page that has only just
loaded cannot be in the middle of anything.

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
- **Dry run is the default**, posts nothing at all, and is never disabled
  while a plan is loaded — it is the diagnostic, so gating it behind a working
  mapping would take it away exactly when it is needed.
- **A disabled button always says why**, underneath the buttons.
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

129 tests. They load the real `background.js` and `content/s4page.js` into a VM
with a stand-in `browser` API and a form shaped like S4's, and cover the things
that would actually corrupt a roster: that duration fields are never mistaken
for the clock fields, that midnight and noon do not post as hour zero, that a
dry run sends nothing, that an incomplete mapping blocks a live run, that error
pages are not counted as successes, that Stop actually stops, that the month
written comes from the plan's dates rather than the page, and that both of S4's
page layouts produce byte-identical POST bodies, that a loaded plan is still
there on the next read, and that the extension's own page is never mistaken
for S4.

They load only what `manifest.json` declares, in the order it declares it.
Handing a context a global it was never actually given is how a missing
dependency hides: `background.js` called into `S4Mapping` while the manifest
loaded only `background.js`, and the tests passed because the harness injected
it by hand. Four of them now check the wiring itself — that the background page
loads what it calls into, that every file the manifest names exists, that
`ui.html`'s scripts and stylesheets resolve, and that `build.sh` packages the
lot.

The fixture serves S4's real two-page shape — a grid with no editor on it,
linking to an editor page that has one — because that is the layout that broke
the first three attempts at this. Its grid carries S4's own `popup()`
definition and a cell per person per October day, and fetching a cell's editor
returns that row's form with its own `cal_id`, so the per-row lookup, the
wrong-user and blank-`cal_id` guards, skipped rows and the dry run's editor
limit are all exercised.

The UI page is loaded too, with the scripts `ui.html` names, and rendered
against real state. `render()` once read a value a line before declaring it;
from then on every render threw once a mapping existed, and the buttons,
status and log stopped updating. Nothing ran the page, so nothing noticed.

The real October plan — 534 blocks, 868 tech-days — runs through the harness
with all 15 shift times, all 28 staff and all 12 fields mapped, and nothing
left over.

---

## What has not been tested

**A live post.** Nothing has been written to S4 yet. Still open:

- **Multi-day blocks.** A block posts once, to the row for its first day, with
  the block's full date range in `startday`…`endyear`. Whether S4 applies that
  range or only changes the one row is not known yet. Diagnostics now report
  `distinctRowIds` and `cellsSpanningDays` for the grid, which answer it.
- **Category values.** They only appear in an editor opened for a real row, so
  the first probe with this build is the first time they will be seen.

Do the dry run, press *Copy diagnostics*, and check `grid.cells`,
`coverage.resolved` and `firstBodies` — the latter are bodies built from real
editors for real rows — against what S4 shows when you edit a shift by hand.

The real S4. I have never been able to reach it, so the form here is a stand-in
built from screenshots of the edit popup. The field names and dropdown values
are discovered at runtime rather than assumed, which is what makes that
survivable — but **do the dry run first**, and read what it says it will post
before letting it write anything.
