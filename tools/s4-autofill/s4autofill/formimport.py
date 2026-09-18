"""Read the team's existing "off form submissions" export.

The team already collects this every month through a form whose sheet has one
row per submission:

    ID | ID 2 | Tech Name | Choose ALL OFF days | Unavoidable Off- 1 |
    Unavoidable Off- 2 | Holiday 1 <name> <date> | Holiday 2 <name> <date> |
    choose LEAVE(CL, ML & PV) days only | Any preferences and notes | Source

Two things matter beyond the dates. The "ID 2" column is the submission
sequence, which is exactly the first-in-first-out key the roster runs on. And
the free-text notes carry real constraints ("no night shift before off days",
"please avoid night shift"); those are surfaced as suggestions for a human to
confirm rather than applied silently, because a wrong reading of a sentence
would quietly put somebody on a shift they cannot work.
"""

from __future__ import annotations

import csv
import datetime as dt
import re
from dataclasses import dataclass, field
from pathlib import Path

from .model import MonthInput, Roster, ShiftConfig
from .monthcal import month_days, parse_month
from .xlsxread import read_rows

MONTHS = {
    m.lower(): i
    for i, m in enumerate(
        ["January", "February", "March", "April", "May", "June", "July",
         "August", "September", "October", "November", "December"], start=1)
}
MONTHS.update({m[:3]: i for m, i in list(MONTHS.items())})

DATE = re.compile(r"([A-Za-z]{3,9})\s+(\d{1,2})")
BARE_DAY = re.compile(r"^\s*(\d{1,2})\s*$")

# Column header -> field. Matched as a lowercase substring, because the sheet's
# holiday headers carry the holiday name and date inside them.
HEADERS = {
    "tech name": "tech",
    "id 2": "sequence",
    "choose all off": "off_days",
    "unavoidable off- 1": "unavoidable_1",
    "unavoidable off- 2": "unavoidable_2",
    "choose leave": "leave_days",
    "preferences and notes": "notes",
}
HOLIDAY_HEADER = re.compile(r"holiday\s*(\d+)", re.I)


@dataclass
class Submission:
    tech: str
    sequence: int
    off_days: list[dt.date] = field(default_factory=list)
    unavoidable: list[dt.date] = field(default_factory=list)
    leave_days: list[dt.date] = field(default_factory=list)
    holidays: list[dt.date] = field(default_factory=list)
    notes: str = ""
    row: int = 0


def parse_dates(text: str, year: int, month: int) -> list[dt.date]:
    """'September 3 Thursday, September 11 Friday' -> two dates.

    Also accepts a bare day number, which people use in the notes column.
    """
    found: list[dt.date] = []
    for chunk in re.split(r"[,;]", text or ""):
        chunk = chunk.strip()
        if not chunk:
            continue
        bare = BARE_DAY.match(chunk)
        if bare:
            day = int(bare.group(1))
            if 1 <= day <= 31:
                try:
                    found.append(dt.date(year, month, day))
                except ValueError:
                    pass
            continue
        for name, day in DATE.findall(chunk):
            index = MONTHS.get(name.lower()) or MONTHS.get(name[:3].lower())
            if not index:
                continue
            try:
                found.append(dt.date(year, index, int(day)))
            except ValueError:
                continue
    ordered: list[dt.date] = []
    for date in found:
        if date not in ordered:
            ordered.append(date)
    return ordered


def _load_table(path: Path) -> list[list[str]]:
    if path.suffix.lower() in {".xlsx", ".xlsm"}:
        return read_rows(path)
    with open(path, newline="") as f:
        return [list(row) for row in csv.reader(f)]


def _map_columns(header: list[str]) -> tuple[dict[str, int], dict[int, str]]:
    columns: dict[str, int] = {}
    holiday_columns: dict[int, str] = {}
    for index, cell in enumerate(header):
        low = (cell or "").strip().lower()
        if not low:
            continue
        for needle, field_name in HEADERS.items():
            if needle in low and field_name not in columns:
                columns[field_name] = index
        if HOLIDAY_HEADER.search(low) and "choose" not in low:
            holiday_columns[index] = cell.strip()
    return columns, holiday_columns


def read_submissions(path: Path, month: str) -> tuple[list[Submission], dict[str, str], list[str]]:
    """Parse the export. Returns (submissions, public holidays, warnings)."""
    year, mon = parse_month(month)
    rows = _load_table(path)
    if not rows:
        raise ValueError(f"{path} is empty")
    columns, holiday_columns = _map_columns(rows[0])
    if "tech" not in columns:
        raise ValueError(
            f"{path}: could not find a 'Tech Name' column. Columns seen: "
            + ", ".join(c for c in rows[0] if c)
        )

    warnings: list[str] = []
    holidays: dict[str, str] = {}
    # The holiday column headers name the holiday and its date, e.g.
    # "Holiday 2 Thiruvonam August 26 Wednesday".
    for header in holiday_columns.values():
        for date in parse_dates(header, year, mon):
            name = re.sub(r"holiday\s*\d+", "", header, flags=re.I)
            name = DATE.sub("", name)
            name = re.sub(r"\b(mon|tues|wednes|thurs|fri|satur|sun)day\b", "", name, flags=re.I)
            holidays[date.isoformat()] = " ".join(name.split()) or "Public holiday"

    def cell(row: list[str], key: str) -> str:
        index = columns.get(key)
        return (row[index] if index is not None and index < len(row) else "") or ""

    submissions: list[Submission] = []
    for number, row in enumerate(rows[1:], start=2):
        tech = cell(row, "tech").strip()
        if not tech:
            continue
        sequence_text = cell(row, "sequence").strip()
        try:
            sequence = int(float(sequence_text))
        except ValueError:
            sequence = number
            if sequence_text:
                warnings.append(
                    f"{tech}: could not read submission order {sequence_text!r}; "
                    f"using the row position instead."
                )
        unavoidable = (parse_dates(cell(row, "unavoidable_1"), year, mon)
                       + parse_dates(cell(row, "unavoidable_2"), year, mon))
        submission = Submission(
            tech=tech,
            sequence=sequence,
            off_days=parse_dates(cell(row, "off_days"), year, mon),
            unavoidable=unavoidable,
            leave_days=parse_dates(cell(row, "leave_days"), year, mon),
            holidays=[d for index in holiday_columns
                      for d in parse_dates(row[index] if index < len(row) else "", year, mon)],
            notes=cell(row, "notes").strip(),
            row=number,
        )
        submissions.append(submission)

    submissions.sort(key=lambda s: (s.sequence, s.row))
    return submissions, holidays, warnings


# --------------------------------------------------------------- note reading

BANDS = r"(?:night|evening|afternoon|morning|noon)"
# "no", not the "no" inside "afternoon" — word boundaries matter here.
# Keep this simple: consuming the following words greedily ate the very band
# word the search then looked for ("don't assign me night shifts").
NEGATOR = re.compile(r"\b(?:no|not|never|avoid|avoiding|without|don'?t|do not)\b", re.I)
SOFTENER = re.compile(r"\b(as much as possible|as far as possible|if possible|preferably|"
                      r"try to|where possible|less|fewer|reduce|minimi[sz]e)\b", re.I)
NIGHT_BEFORE_OFF = re.compile(
    r"(night.{0,30}\b(?:before|prior to)\b.{0,20}off|off.{0,30}\b(?:after|following)\b.{0,20}night)",
    re.I)
FEWER = re.compile(rf"\b(?:less|fewer|reduce|minimi[sz]e)\b[^.]{{0,20}}\bnight", re.I)
PREFERS = re.compile(rf"\b({BANDS})\b[^.]{{0,20}}\b(?:preferred|prefer|preference)\b", re.I)
OFFS_IN_SEQUENCE = re.compile(r"offs?\b.{0,20}\bin sequence|consecutive\s+offs?", re.I)


@dataclass
class Suggestion:
    tech: str
    kind: str
    because: str
    quote: str

    def describe(self) -> str:
        return f"{self.tech:14} {self.kind:20} {self.because}  ← “{self.quote}”"


def _sentences(text: str) -> list[str]:
    """Split on sentence enders. People put unrelated requests in one note, and
    matching across them is how 'No night shift morning shift preferred' turns
    into 'never schedule mornings'."""
    flat = " ".join((text or "").split())
    return [s.strip() for s in re.split(r"[.;\n]", flat) if s.strip()]


def _negated(sentence: str, band: str) -> str | None:
    """Find 'no <band>' where no *other* band word sits in between.

    Without that check, 'No night shift morning shift preferred' reads as a ban
    on mornings — the exact opposite of what the person asked for.
    """
    for match in NEGATOR.finditer(sentence):
        tail = sentence[match.end():match.end() + 40]
        hit = re.search(rf"\b{band}\b", tail, re.I)
        if not hit:
            continue
        if re.search(BANDS, tail[:hit.start()], re.I):
            continue
        return sentence[max(0, match.start() - 15):match.end() + hit.end() + 15].strip()
    return None


def read_notes(submissions: list[Submission]) -> list[Suggestion]:
    """Spot constraints hiding in the free-text column.

    Deliberately conservative and never applied on its own — a sentence read
    wrong here would put somebody on a shift they told you they cannot work.
    """
    suggestions: list[Suggestion] = []

    def add(tech: str, kind: str, because: str, quote: str) -> None:
        if not any(s.tech == tech and s.kind == kind for s in suggestions):
            suggestions.append(Suggestion(tech, kind, because, quote.strip()))

    for submission in submissions:
        for sentence in _sentences(submission.notes):
            tech = submission.tech

            before_off = NIGHT_BEFORE_OFF.search(sentence)
            if before_off:
                add(tech, "no_night_before_off",
                    "no night shift running into a day off", before_off.group(0))

            night = _negated(sentence, "night")
            if night and not before_off:
                # "don't give me nights as much as possible" is a request to cut
                # them down, not a hard ban. Read it as the weaker of the two.
                if SOFTENER.search(sentence):
                    add(tech, "fewer_nights", "wants nights kept down (softened wording)", night)
                else:
                    add(tech, "avoid_nights", "never schedule nights", night)
            elif FEWER.search(sentence):
                add(tech, "fewer_nights", "wants fewer nights than the standard cap",
                    FEWER.search(sentence).group(0))

            morning = _negated(sentence, "morning")
            if morning:
                add(tech, "avoid_mornings", "never schedule mornings", morning)

            preference = PREFERS.search(sentence)
            if preference:
                band = preference.group(1).lower()
                if band == "morning":
                    add(tech, "prefer_mornings", "prefers morning shifts", preference.group(0))
                elif band in {"evening", "afternoon"}:
                    add(tech, "prefer_evenings", "prefers evening shifts", preference.group(0))

            sequence = OFFS_IN_SEQUENCE.search(sentence)
            if sequence:
                add(tech, "offs_in_sequence", "wants days off next to each other",
                    sequence.group(0))
    return suggestions


def apply_suggestions(suggestions: list[Suggestion], roster: Roster, config: ShiftConfig,
                      fewer_nights_cap: int = 4) -> list[str]:
    """Turn confirmed suggestions into roster settings."""
    nights = [s.id for s in config.slots if s.is_night]
    mornings = [s.id for s in config.slots if s.band == "morning" and not s.dedicated]
    applied: list[str] = []
    for suggestion in suggestions:
        if not roster.has(suggestion.tech):
            continue
        tech = roster.get(suggestion.tech)
        if suggestion.kind == "avoid_nights":
            tech.avoid_slots = sorted(set(tech.avoid_slots) | set(nights))
            applied.append(f"{tech.id}: avoid_slots += {', '.join(nights)}")
        elif suggestion.kind == "fewer_nights":
            tech.max_nights_per_month = fewer_nights_cap
            applied.append(f"{tech.id}: max_nights_per_month = {fewer_nights_cap}")
        elif suggestion.kind == "no_night_before_off":
            tech.no_night_before_off = True
            applied.append(f"{tech.id}: no_night_before_off = true")
        elif suggestion.kind == "avoid_mornings":
            tech.avoid_slots = sorted(set(tech.avoid_slots) | set(mornings))
            applied.append(f"{tech.id}: avoid_slots += {', '.join(mornings)}")
        elif suggestion.kind in {"prefer_mornings", "prefer_evenings"}:
            band = "morning" if suggestion.kind == "prefer_mornings" else "evening"
            wanted = [s.id for s in config.slots
                      if s.band == band and not s.dedicated and s.target > 0]
            if wanted and not tech.preferences:
                tech.preferences = wanted[:3]
                applied.append(f"{tech.id}: preferences = {', '.join(tech.preferences)}")
    return applied


def to_month_input(submissions: list[Submission], roster: Roster, config: ShiftConfig,
                   month: str, holidays: dict[str, str],
                   leave_category: str = "CL") -> tuple[MonthInput, list[str]]:
    """Build the month input, and set each tech's FIFO position from their
    place in the submission queue."""
    year, mon = parse_month(month)
    days = set(month_days(year, mon))
    month_input = MonthInput(month=month, public_holidays=dict(holidays))
    warnings: list[str] = []

    for position, submission in enumerate(submissions):
        if not roster.has(submission.tech):
            warnings.append(
                f"{submission.tech}: submitted a form but is not in the roster — ignored. "
                f"Add them with: s4autofill roster add {submission.tech} --division SA|SM"
            )
            continue
        tech = roster.get(submission.tech)
        if not tech.active:
            warnings.append(f"{submission.tech}: submitted a form but is marked inactive — ignored.")
            continue

        # Submission order is the queue: first in, first served.
        tech.prefs_submitted_at = f"{month}-01T00:{position:02d}:00"
        if submission.notes:
            tech.notes = submission.notes

        # The form's two "Unavoidable Off" columns are exactly the requests
        # that must not be handed back when a day is over-subscribed.
        fixed = [d.isoformat() for d in submission.unavoidable if d in days]
        if fixed:
            month_input.unavoidable.setdefault(tech.id, []).extend(fixed)

        dated: dict[str, str] = {}
        for date in submission.off_days + submission.unavoidable:
            if date in days:
                dated[date.isoformat()] = "OFF"
            else:
                warnings.append(f"{tech.id}: off day {date} is outside {month} — ignored.")
        for date in submission.leave_days:
            if date in days:
                dated[date.isoformat()] = leave_category
            else:
                warnings.append(f"{tech.id}: leave day {date} is outside {month} — ignored.")
        for date in submission.holidays:
            if date in days:
                dated[date.isoformat()] = "PH"
        if dated:
            month_input.leave.setdefault(tech.id, {}).update(dated)

        offs = sum(1 for c in dated.values() if c == "OFF")
        targets: dict[str, int] = {"off_days": offs}
        leaves = sum(1 for c in dated.values() if c == leave_category)
        if leaves:
            targets[leave_category] = leaves
        month_input.targets[tech.id] = targets

    submitted = {s.tech for s in submissions}
    missing = [t.id for t in roster.techs if t.active and t.id not in submitted]
    if missing:
        warnings.append(
            f"{len(missing)} active tech(s) did not submit the form, so only their fixed "
            f"off days are used: {', '.join(missing)}"
        )
    return month_input, warnings


__all__ = [
    "Submission", "Suggestion", "parse_dates", "read_submissions", "read_notes",
    "apply_suggestions", "to_month_input",
]
