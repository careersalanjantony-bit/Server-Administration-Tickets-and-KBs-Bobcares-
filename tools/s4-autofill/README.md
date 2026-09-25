# S4 shift autofill

Builds next month's Installation-team roster and writes it into S4.

It reads the same shape S4 already uses — the shift-time columns, fixed offs,
the leave categories, the Flexy column — plans a month against them, shows you
a draft, and only then posts. Nothing reaches S4 until you pass `--execute`.

Python 3.11+, standard library only. No install step.

---

## The short version

You already collect the off requests through a form. Start from that export.

```bash
cd tools/s4-autofill

# 1. Import the month's "off form submissions" export (.xlsx or .csv)
python3 -m s4autofill import-form 'November off form submissions.xlsx' \
    --month 2026-11 --apply-notes --save

# 2. Build the month
python3 -m s4autofill plan --month 2026-11 \
    --holiday 2026-11-14="Children's Day"

# 3. Open out/2026-11/preview.html and read it

# 4. Fill S4 — easiest with the Firefox extension, see below

# 5. Dry run, then for real
export S4_USER=... S4_PASSWORD=...
python3 -m s4autofill push --month 2026-11 --verbose
python3 -m s4autofill push --month 2026-11 --execute
```

---

## Importing the off-request form

`import-form` reads the sheet the team already fills in every month:

    ID | ID 2 | Tech Name | Choose ALL OFF days | Unavoidable Off- 1 |
    Unavoidable Off- 2 | Holiday 1 <name> <date> | Holiday 2 <name> <date> |
    choose LEAVE(CL, ML & PV) days only | Any preferences and notes | Source

It reads `.xlsx` directly (no dependencies) or `.csv`. Column headers are
matched loosely, so the holiday columns keep working when the holiday changes.

Three things it takes from the sheet beyond the dates:

- **`ID 2` is the submission order**, and becomes each person's place in the
  FIFO queue. Nothing else needs filling in for the queue to work.
- **The two "Unavoidable Off" columns** mark requests that must not be handed
  back when a day is over-subscribed (see arbitration below).
- **The holiday column headers** carry the holiday's name and date, so public
  holidays are picked up without being typed again.

The CL/ML/PV column does not say which of the three a day is; everything in it
becomes `CL` unless you pass `--leave-category`.

### The free-text notes

The notes column carries real constraints. `import-form` reads it and prints
what it finds, but **applies nothing** unless you pass `--apply-notes`:

```
anoop.g      avoid_nights         never schedule nights            ← "No night shift"
anoop.g      prefer_mornings      prefers morning shifts           ← "morning shift preferred"
alan.j       no_night_before_off  no night running into a day off  ← "offs immediately after night"
alan.j       fewer_nights         nights kept down (softened)      ← "don't assign me night shifts as much"
kuriakose.j  no_night_before_off  no night running into a day off  ← "night shift before off"
sidharth.ps  prefer_evenings      prefers evening shifts           ← "Evening shift preferred"
```

It reads sentence by sentence, which matters more than it sounds. Against the
team's real September notes, a naive reader got three of these badly wrong: it
saw the "no" inside *after****no****on*, it turned "No night shift **morning
shift preferred**" into a ban on mornings, and it flagged kuriakose.j — who
wrote "I am ok with night shifts" — as refusing them. Those three are locked in
as regression tests. Softened wording ("as much as possible") is read as
*fewer*, not *never*.

Always read the suggestions before applying them. Anything it misses, set by
hand with `roster set`.

## The manual sheet

If you would rather not use the form export, `intake` writes one CSV row per person. That sheet *is* the question — send it
round, or paste it into a spreadsheet and share it. The columns people fill in:

| Column | What you are asking |
|---|---|
| `total_off_days` | How many days off this month. Pre-filled with what their fixed-off weekdays already give, so they only change it if they want more. |
| `cl_days` | Casual leave days |
| `public_holiday_days` | How many of the declared public holidays they are taking |
| `ml_days`, `ecl_days`, `paid_vacation_days`, `unpaid_leave_days`, `duty_leave_days` | The rest of the S4 leave columns |
| `leave_dates` | Exact dates when they already know them: `5:CL; 12:PH; 2026-11-19:PV` |
| `preference_1..3` | Shift slots they want, best first — ids from `slot-legend.csv` |
| `avoid_slots` | Slots they cannot do at all (e.g. no nights) |
| `prefs_submitted_at` | When they asked. **This is the FIFO key** — see below. |
| `fixed_off` | Their standing days off, if they have changed |

Counts without dates are placed for them: casual leave lands next to a day off
so it makes a longer break, extra off days are spread out to break up long
working runs, and public holidays can only land on dates you declared with
`--holiday`. Exact dates in `leave_dates` are honoured as given.

---

## How the month is built

In order:

1. **Days off** — fixed weekday pattern, then any dated leave from the sheet.
2. **Arbitration** — if more people asked for a day off than the roster can
   cover, the latest requests are handed back (see below).
3. **Quota leave** — the CL / PH / PV counts, placed on days the team can spare.
4. **Extra offs** — when someone asked for more days off than their pattern gives.
5. **Dedicated slots** — permanent shift owners (currently `sherin` 08:00 and
   `bittu.eg` 11:30) get their slot every working day.
6. **Coverage** — every slot filled to its minimum, then towards its target.
7. **Flexy** — whoever is left, with a per-person time, exactly as S4 stores it.

### First in, first out

`prefs_submitted_at` orders a queue. When two people want the same slot, the
one who asked first gets it — **and then goes to the back of the queue**. Being
given a shift you did *not* ask for costs you nothing: you keep your place and
win the next contest. Over a month that splits a popular slot evenly between
everyone who wants it, in the order they asked.

### Over-subscribed days off

People ask for the same popular days. When more offs are requested than the
roster can cover, the same queue settles it: whoever asked first keeps theirs,
and the latest requests are handed back, one at a time, until the day is
coverable. Fixed weekday offs and anything in the form's "Unavoidable Off"
columns are never taken back. Every hand-back is reported by name, date and
queue position, so you can tell the person why.

If a day is still short after every revocable request has been handed back, it
says so plainly — that one needs a fixed off or an unavoidable request to move,
which is a management decision, not a scheduling one.

Someone who lists no preference is never disadvantaged — they are placed by
whoever has had that band least, so nights stay spread.

### Rules it will not break

| Rule | Default | Where |
|---|---|---|
| Rest between shifts | 11 hours | `rules.min_rest_hours_between_shifts` |
| Nights in a row | 5 | `rules.max_consecutive_nights` |
| Nights per month | 10 | `rules.max_nights_per_month_default`, per-person override on the tech |
| Working days in a row | 6 (warning, not blocked) | `rules.max_consecutive_working_days` |
| `avoid_slots` | never assigned | per tech |
| No night before a day off | off by default | `no_night_before_off` per tech |
| Coverage minimums | per slot, plus per-division floors | `config/shifts.json` |

Three things make thin days work.

Coverage is filled **most-constrained slot first** — the seat with the fewest
people who could take it gets filled before the easy ones, which is how a
Sunday with most of the team off still gets covered at all.

Before anyone goes on a late shift, the scheduler checks that enough rested
people **of the right division** are left to open the next morning; if the day
still ends short, it pulls somebody forward onto an earlier shift.

And when a seat cannot be filled directly, it searches for an **augmenting
path**: move A onto the empty seat, backfill A's slot with B, backfill B's with
C, and so on. A single swap is not enough on a day where everybody is already
placed — without the chain, days that have a perfectly valid assignment still
come out short.

Anything it genuinely cannot solve is reported as a `coverage-shortfall`, never
hidden. A shortfall means the roster is short of people that day, and the fix
is a human one: move a fixed off, or lower that slot's minimum.

---

## Adding and removing techs

The roster is `config/roster.json` and changes through the CLI.

```bash
# joiner — they simply do not exist before their start date
python3 -m s4autofill roster add nikhil.r --division SA \
    --fixed-off Saturday Sunday --joined 2026-11-10

# leaver — deactivate, do not delete: old months still refer to them
python3 -m s4autofill roster remove annet.pj --left 2026-12-01

# change anything
python3 -m s4autofill roster set noufiya.n --prefer n2258 e1458 \
    --submitted-at 2026-10-25T09:00:00
python3 -m s4autofill roster set sijin --division SM

python3 -m s4autofill roster list --division SA
```

`--hard` on `remove` deletes the row outright. Prefer the default: a
deactivated tech keeps their history and can be switched back on with
`roster set <id> --active yes`.

A tech who owns a dedicated slot needs two edits: `--fixed-slot <id>` on them,
and their id in that slot's `dedicated` list in `config/shifts.json`. The
validator errors if the two disagree.

---

## Changing coverage

`config/shifts.json` holds the slot catalogue. Every slot has `min` (never go
below), `target` (aim for), `max` (never exceed) and optional `division_min`,
e.g. `{"SA": 1, "SM": 1}` to guarantee both divisions are represented.

The shipped numbers were derived from the S4 September 2026 Average Count row,
which is recorded next to each slot as `observed_avg` so you can see where they
came from. Change the numbers, re-run `plan`, compare the Average Count line at
the bottom of `summary.csv` against `observed_avg`.

---

## Filling S4

Two ways in. **The Firefox extension is the easy one** and is what the team
should use day to day — S4 is internal-only, so an extension running in your own
browser is the one thing that can reach it without credentials living anywhere.

```bash
python3 -m s4autofill plan --month 2026-11    # writes out/2026-11/plan.json
```

Load [`extension/`](extension/) via `about:debugging`, open S4, load
`plan.json`, read the form, dry run, fill. It works the dropdown mapping out
itself, refuses to post while anything is unmatched, stops after 3 failures and
has a Stop button. See [`extension/README.md`](extension/README.md).

The command-line `push` below does the same job from a machine that can reach
S4, if you would rather script it.

## Connecting to S4 from the command line

S4's form field names are **not** hard-coded, because guessing them would write
the wrong thing into a live roster. `config/s4_form.json` ships with
placeholders and `push --execute` refuses to run while any remain.

S4 is internal-only, so there are two ways to do this. Either works; both are
one-time.

**From the browser (no network access needed).** Log in to S4, open the shift
edit page, open the console (F12), and paste in
[`docs/collect-s4-form.js`](docs/collect-s4-form.js). It copies a JSON block to
your clipboard. Save it and run:

```bash
python3 -m s4autofill inspect --save --from-json s4-form-dump.json
```

The snippet reads field names and dropdown options only. It sends nothing
anywhere and deliberately skips the contents of any password field.

**From a machine that can reach S4**, skip the browser step:

```bash
python3 -m s4autofill inspect --save --url '<the shift edit page>'
```

Either way it works out which dropdown option means which slot, category and
tech by itself — the slot labels in `shifts.json` were transcribed from S4's
own column headers, so they match its dropdown text directly, including
S4's inconsistent leading zeros (`7:00am-3:00pm` vs `07:02am-03:02pm`).
Anything it cannot match is listed by name rather than guessed, and it tells
you whether the mapping is complete.

Credentials come from `S4_USER` / `S4_PASSWORD` in the environment and are
never read from a config file.

`push` collapses consecutive identical days into date ranges, so a month is a
few hundred submissions rather than a thousand — S4's form takes a start and
end date, which is exactly this. It re-validates the month and refuses to send
if there are errors.

---

## Output

`plan` writes into `out/<month>/`:

| File | What it is |
|---|---|
| `preview.html` | The month in S4's own layout and colours — **read this one** |
| `grid.csv` | Same grid as a spreadsheet |
| `schedule.csv` | One row per tech per day |
| `summary.csv` | The end-of-month summary: days per slot, offs, each leave column, and an Average Count row |
| `payloads.jsonl` | Exactly what `push` will send |
| `plan.json` | What the Firefox extension loads |

---

## Tests

```bash
python3 -m pytest tests/ -q      # 103 tests, the planner
cd extension && node --test      # 41 tests, the extension
```

---

## Sundays are the binding constraint

**16 of the 28 active techs are off on Sundays**, which leaves 12 people
against a 12-person coverage floor — no margin at all. Every Sunday works, but
one unplanned sick day breaks it, and once everyone's stated night
restrictions are honoured a few Sundays cannot be covered at all.

Three levers were tested against October 2026, and each one clears it
completely:

| Change | Result |
|---|---|
| as-is | 3 shortfalls |
| move one weekend person's fixed off to midweek (e.g. `roys.yb` or `akshay.b`) | clean |
| lower the `11:00pm-7:00am` minimum from 2 to 1 | clean |

None of these is applied — it is a management decision. Pick one and either
`roster set <id> --fixed-off Monday Tuesday` or edit `min` in
`config/shifts.json`.

## Known gaps

- `akhil.v`, `rasikh.mk` and `rajkumar.r` have assumed email local-parts.
- `sijin`, `annet.pj`, `ranit.b`, `amrina.s` and `gowtham.c` are marked
  inactive (left the team). `sijin` owned the 07:30am-03:30pm slot, which is
  now an ordinary slot with no dedicated owner.
- Preferences come from the September form notes. They are re-read from each
  month's form export, so they stay current on their own.
- Anyone who does not submit the form is scheduled on their fixed offs only,
  and `import-form` lists them so you can chase them.
