"""The 'ask every tech' sheet: emit a CSV, read the filled-in copy back.

One row per tech. The lead sends it round, everyone fills in their off days,
CL, public holidays and their ordered shift preferences, and the filled sheet
becomes the month input the scheduler runs on.
"""

from __future__ import annotations

import csv
import datetime as dt
from pathlib import Path
from typing import Any, Iterable

from .model import MonthInput, Roster, ShiftConfig, Tech
from .monthcal import month_days, normalise_weekdays, parse_month, weekday_index

COLUMNS = [
    "tech_id", "display_name", "division", "active", "fixed_off",
    "preference_1", "preference_2", "preference_3", "avoid_slots", "prefs_submitted_at",
    "total_off_days", "cl_days", "public_holiday_days",
    "ml_days", "ecl_days", "paid_vacation_days", "unpaid_leave_days", "duty_leave_days",
    "leave_dates", "notes",
]

# intake column -> leave category used in the plan
QUOTA_COLUMNS = {
    "cl_days": "CL",
    "public_holiday_days": "PH",
    "ml_days": "ML",
    "ecl_days": "ECL",
    "paid_vacation_days": "PV",
    "unpaid_leave_days": "UL",
    "duty_leave_days": "DL",
}


def fixed_off_count(tech: Tech, year: int, month: int) -> int:
    """How many fixed-off days this tech's weekday pattern yields in the month."""
    wanted = tech.fixed_off_indexes
    return sum(1 for d in month_days(year, month) if d.weekday() in wanted)


def write_intake(
    roster: Roster, config: ShiftConfig, month: str, path: Path,
    include_inactive: bool = False,
) -> Path:
    """Write the blank (or pre-filled) intake sheet for a month."""
    year, mon = parse_month(month)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=COLUMNS)
        writer.writeheader()
        for tech in roster.techs:
            if not tech.active and not include_inactive:
                continue
            prefs = list(tech.preferences) + ["", "", ""]
            writer.writerow({
                "tech_id": tech.id,
                "display_name": tech.display_name,
                "division": tech.division,
                "active": "yes" if tech.active else "no",
                "fixed_off": "|".join(tech.fixed_off),
                "preference_1": prefs[0],
                "preference_2": prefs[1],
                "preference_3": prefs[2],
                "avoid_slots": "|".join(tech.avoid_slots),
                "prefs_submitted_at": tech.prefs_submitted_at,
                # Pre-filled with what the fixed-off pattern already gives them,
                # so a tech only edits the number if they want more.
                "total_off_days": fixed_off_count(tech, year, mon),
                "cl_days": 0,
                "public_holiday_days": 0,
                "ml_days": 0,
                "ecl_days": 0,
                "paid_vacation_days": 0,
                "unpaid_leave_days": 0,
                "duty_leave_days": 0,
                "leave_dates": "",
                "notes": tech.notes,
            })
    return path


def write_slot_legend(config: ShiftConfig, path: Path) -> Path:
    """Companion sheet so people know which slot id to put in preference_1."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["slot_id", "shift_time", "band", "min_per_day", "target_per_day", "max_per_day"])
        for s in config.slots:
            writer.writerow([s.id, s.label, s.band, s.min, s.target, s.max])
    return path


def _int(value: str | None, field: str, tech_id: str) -> int:
    text = (value or "").strip()
    if not text:
        return 0
    try:
        return int(float(text))
    except ValueError as exc:
        raise ValueError(f"{tech_id}: {field} must be a number, got {value!r}") from exc


def _split(value: str | None) -> list[str]:
    return [p.strip() for p in (value or "").replace(",", "|").split("|") if p.strip()]


def parse_leave_dates(spec: str, year: int, month: int, tech_id: str) -> dict[str, str]:
    """'2026-10-05:CL; 12:PH' -> {'2026-10-05': 'CL', '2026-10-12': 'PH'}."""
    out: dict[str, str] = {}
    for chunk in spec.replace(",", ";").split(";"):
        chunk = chunk.strip()
        if not chunk:
            continue
        if ":" not in chunk:
            raise ValueError(f"{tech_id}: leave_dates entry {chunk!r} must be DATE:CATEGORY")
        date_part, category = (p.strip() for p in chunk.split(":", 1))
        try:
            day = (
                dt.date.fromisoformat(date_part)
                if "-" in date_part
                else dt.date(year, month, int(date_part))
            )
        except ValueError as exc:
            raise ValueError(f"{tech_id}: bad date {date_part!r} in leave_dates") from exc
        if (day.year, day.month) != (year, month):
            raise ValueError(f"{tech_id}: leave date {day} is outside {year}-{month:02d}")
        out[day.isoformat()] = category.upper()
    return out


def read_intake(
    path: Path, roster: Roster, config: ShiftConfig, month: str,
    apply_to_roster: bool = True,
) -> tuple[MonthInput, list[str]]:
    """Read a filled sheet into a MonthInput, optionally updating the roster.

    Returns (month_input, warnings). Unknown tech ids are a hard error: a typo
    there would silently drop somebody from the schedule.
    """
    year, mon = parse_month(month)
    valid_slots = {s.id for s in config.slots}
    valid_categories = set(config.categories) | set(config.leave_categories)
    month_input = MonthInput(month=month)
    warnings: list[str] = []

    with open(path, newline="") as f:
        for lineno, row in enumerate(csv.DictReader(f), start=2):
            tech_id = (row.get("tech_id") or "").strip()
            if not tech_id:
                continue
            if not roster.has(tech_id):
                raise ValueError(
                    f"{path}:{lineno}: '{tech_id}' is not in the roster — "
                    f"add them first with: s4autofill roster add {tech_id} ..."
                )
            tech = roster.get(tech_id)

            prefs = [
                p for p in (
                    (row.get("preference_1") or "").strip(),
                    (row.get("preference_2") or "").strip(),
                    (row.get("preference_3") or "").strip(),
                ) if p
            ]
            for p in prefs:
                if p not in valid_slots:
                    raise ValueError(f"{path}:{lineno}: {tech_id} asked for unknown slot {p!r}")
            avoid = _split(row.get("avoid_slots"))
            for a in avoid:
                if a not in valid_slots:
                    raise ValueError(f"{path}:{lineno}: {tech_id} avoid_slots has unknown slot {a!r}")

            if apply_to_roster:
                if prefs:
                    tech.preferences = prefs
                if avoid:
                    tech.avoid_slots = avoid
                submitted = (row.get("prefs_submitted_at") or "").strip()
                if submitted:
                    tech.prefs_submitted_at = submitted
                off_spec = _split(row.get("fixed_off"))
                if off_spec:
                    tech.fixed_off = normalise_weekdays(off_spec)
                active = (row.get("active") or "").strip().lower()
                if active in {"yes", "no", "true", "false", "y", "n"}:
                    tech.active = active in {"yes", "true", "y"}

            targets = {"off_days": _int(row.get("total_off_days"), "total_off_days", tech_id)}
            for column, category in QUOTA_COLUMNS.items():
                count = _int(row.get(column), column, tech_id)
                if count:
                    targets[category] = count
            month_input.targets[tech_id] = targets

            dated = parse_leave_dates(row.get("leave_dates") or "", year, mon, tech_id)
            for iso, category in dated.items():
                if category not in valid_categories:
                    raise ValueError(f"{path}:{lineno}: {tech_id} unknown leave category {category!r}")
            if dated:
                month_input.leave.setdefault(tech_id, {}).update(dated)

            natural = fixed_off_count(tech, year, mon)
            if targets["off_days"] < natural:
                warnings.append(
                    f"{tech_id}: asked for {targets['off_days']} off days but the fixed-off "
                    f"pattern ({'/'.join(tech.fixed_off) or 'none'}) already gives {natural}; "
                    f"keeping {natural}."
                )

    listed = set(month_input.targets)
    for tech in roster.techs:
        if tech.active and tech.id not in listed:
            warnings.append(f"{tech.id}: active but missing from the intake sheet — using defaults.")
    return month_input, warnings


def holidays_from_args(pairs: Iterable[str]) -> dict[str, str]:
    """--holiday 2026-10-02='Gandhi Jayanti' pairs into a dict."""
    out: dict[str, str] = {}
    for pair in pairs:
        if "=" not in pair:
            raise ValueError(f"holiday must look like YYYY-MM-DD=Name, got {pair!r}")
        date_part, name = pair.split("=", 1)
        out[dt.date.fromisoformat(date_part.strip()).isoformat()] = name.strip()
    return out


__all__: list[Any] = [
    "COLUMNS", "QUOTA_COLUMNS", "write_intake", "write_slot_legend", "read_intake",
    "parse_leave_dates", "fixed_off_count", "holidays_from_args",
]
