# S4 shift autofill

Builds next month's Installation-team roster and writes it into S4.

It reads the same shape S4 already uses — the shift-time columns, fixed offs,
the leave categories, the Flexy column — plans a month against them, shows you
a draft, and only then posts. Nothing reaches S4 until you pass `--execute`.

Python 3.11+, standard library only. No install step.

---

## The short version

```bash
cd tools/s4-autofill

# 1. Ask everyone their offs / CL / public holidays
python3 -m s4autofill intake --month 2026-11

# 2. Collect the filled-in sheet, then build the month
python3 -m s4autofill plan --month 2026-11 \
    --intake intake/2026-11/intake-2026-11.csv \
    --holiday 2026-11-14="Children's Day" \
    --save-input

# 3. Open out/2026-11/preview.html and read it

# 4. Teach it S4's form once (from a machine that can reach S4)
python3 -m s4autofill inspect --save \
    --url 'https://s4.inhouse.net/index.php?action=view_shift&sdate=2026-11-01&edate=2026-11-30&t=6&edit_co_shift=N'

# 5. Dry run, then for real
export S4_USER=... S4_PASSWORD=...
python3 -m s4autofill push --month 2026-11 --verbose
python3 -m s4autofill push --month 2026-11 --execute
```

---

## What to ask each tech

`intake` writes one CSV row per person. That sheet *is* the question — send it
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
2. **Quota leave** — the CL / PH / PV counts, placed on days the team can spare.
3. **Extra offs** — when someone asked for more days off than their pattern gives.
4. **Dedicated slots** — permanent shift owners (currently `sijin` 07:30,
   `sherin` 08:00, `bittu.eg` 11:30) get their slot every working day.
5. **Coverage** — every slot filled to its minimum, then towards its target.
6. **Flexy** — whoever is left, with a per-person time, exactly as S4 stores it.

### First in, first out

`prefs_submitted_at` orders a queue. When two people want the same slot, the
one who asked first gets it — **and then goes to the back of the queue**. Being
given a shift you did *not* ask for costs you nothing: you keep your place and
win the next contest. Over a month that splits a popular slot evenly between
everyone who wants it, in the order they asked.

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
| Coverage minimums | per slot, plus per-division floors | `config/shifts.json` |

Two things make thin days work. Coverage is filled **most-constrained slot
first** — the seat with the fewest people who could take it gets filled before
the easy ones, which is how a Sunday with two thirds of the team off still gets
covered. And before anyone is put on a late shift, the scheduler checks that
enough rested people — of the right division — are left to open the next
morning; if the day still ends short, it pulls somebody forward onto an earlier
shift rather than leaving a gap.

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

## Connecting to S4

S4's form field names are **not** hard-coded, because guessing them would write
the wrong thing into a live roster. `config/s4_form.json` ships with
placeholders and `push --execute` refuses to run while any remain.

```bash
python3 -m s4autofill inspect --save --url '<the shift edit page>'
```

That prints every input, select and option on the page, fills in the field
names it is confident about, and dumps the dropdown options under
`discovered_select_options`. Copy those into `shift_time_values` (slot id →
S4's option value), `category_values` (W/CL/PH/… → S4's value) and
`staff_values` (tech id → S4's staff id). One-time job.

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

---

## Tests

```bash
python3 -m pytest tests/ -q
```

---

## Known gaps

- `ranit.b` is in the SA list but not in the September S4 sheet, so their fixed
  off days are unknown and the validator warns until you set them.
- `sijin` and `annet.pj` work in S4 but were not on either division list.
  They are marked `UNASSIGNED`, which means division floors cannot count them.
- `akhil.v`, `rasikh.mk` and `rajkumar.r` have assumed email local-parts.
- `amrina.s` and `gowtham.c` had zero days in September and are marked inactive.
- Nobody has preferences yet — the first `intake` round fills them in. Until
  then everyone is treated as having no preference, which is fair but arbitrary.
