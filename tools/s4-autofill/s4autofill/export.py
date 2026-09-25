"""Outputs: the long schedule, an S4-shaped grid, the month summary, an HTML
preview, and the batched payloads the S4 client posts.
"""

from __future__ import annotations

import csv
import datetime as dt
import html
import json
from dataclasses import dataclass
from pathlib import Path

from .model import Roster, ShiftConfig, Tech
from .monthcal import s4_date, weekday_name
from .scheduler import Plan

# Same palette S4 uses in the month view, so a preview reads the same way.
BAND_COLOURS = {
    "morning": "#FFC0CB",
    "day": "#A9A9A9",
    "evening": "#9ACD32",
    "night": "#A9A9A9",
    "flexy": "#DCE9F7",
}
OFF_COLOUR = "#F3F3F3"


def _label(tech: Tech, category: str, window: str = "") -> str:
    """'akhil.ep -ITW', 'abhijith.mn-TTR', 'noufiya.n [01:00am-09:00am]-W' —
    the way S4 renders a cell."""
    name = tech.display_name
    if window:
        return f"{name} {window}-{category}"
    return f"{name} -{category}" if category not in {"W", "OFF"} else name


def _window(start: str, duration_min: int) -> str:
    begin = dt.datetime.combine(dt.date(2000, 1, 1), dt.time(*map(int, start.split(":"))))
    end = begin + dt.timedelta(minutes=duration_min)
    fmt = lambda t: t.strftime("%I:%M%p").lower()
    return f"[{fmt(begin)}-{fmt(end)}]"


@dataclass
class Batch:
    """One S4 form submission: a person, a slot, and a run of dates."""

    tech_id: str
    slot_id: str
    category: str
    start: dt.date
    end: dt.date
    time: str = ""
    source: str = ""

    @property
    def days(self) -> int:
        return (self.end - self.start).days + 1


def batch_assignments(plan: Plan) -> list[Batch]:
    """Collapse per-day rows into date ranges — S4's form takes a range."""
    batches: list[Batch] = []
    for tech_id, rows in sorted(plan.by_tech().items()):
        current: Batch | None = None
        for row in rows:
            key = (row.slot_id, row.category, row.start or "")
            if current and (current.slot_id, current.category, current.time) == key \
                    and row.date == current.end + dt.timedelta(days=1):
                current.end = row.date
                continue
            if current:
                batches.append(current)
            current = Batch(tech_id, row.slot_id or "", row.category,
                            row.date, row.date, row.start or "", row.source)
        if current:
            batches.append(current)
    batches.sort(key=lambda b: (b.start, b.tech_id))
    return batches


def write_schedule_csv(plan: Plan, config: ShiftConfig, roster: Roster, path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["date", "weekday", "tech_id", "division", "category", "slot_id",
                    "shift_time", "start", "source"])
        for a in plan.assignments:
            slot = config.slot(a.slot_id) if a.slot_id else None
            w.writerow([
                a.date.isoformat(), weekday_name(a.date), a.tech_id,
                roster.get(a.tech_id).division, a.category,
                a.slot_id or "", slot.label if slot else "",
                a.start or "", a.source,
            ])
    return path


def write_grid_csv(plan: Plan, config: ShiftConfig, roster: Roster, path: Path) -> Path:
    """The S4 month view: one row per date, one column per shift time."""
    path.parent.mkdir(parents=True, exist_ok=True)
    slots = config.slots
    by_date = plan.by_date()
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Date"] + [s.label for s in slots] + ["Leaves/Offs"])
        for day in plan.days:
            cells: dict[str, list[str]] = {s.id: [] for s in slots}
            offs: list[str] = []
            for a in sorted(by_date[day], key=lambda x: x.tech_id):
                tech = roster.get(a.tech_id)
                if a.slot_id:
                    slot = config.slot(a.slot_id)
                    window = _window(a.start or slot.start, slot.duration_min) if slot.is_flexy else ""
                    cells[a.slot_id].append(_label(tech, a.category, window))
                else:
                    offs.append(f"{tech.display_name} {a.category}")
            w.writerow(
                [f"{weekday_name(day)[:3]}, {day.day} {day.strftime('%b')}"]
                + [", ".join(cells[s.id]) for s in slots]
                + [", ".join(offs)]
            )
    return path


def write_summary_csv(plan: Plan, config: ShiftConfig, roster: Roster, path: Path) -> Path:
    """The bottom-of-month summary S4 shows: days per slot, then offs and leaves."""
    path.parent.mkdir(parents=True, exist_ok=True)
    slots = config.slots
    categories = config.leave_categories
    per_tech = plan.by_tech()
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(
            ["No", "Staff", "Division", "Fixed OFF"]
            + [s.label for s in slots]
            + ["Working Days"] + categories + ["Total"]
        )
        for number, tech_id in enumerate(sorted(per_tech), start=1):
            rows = per_tech[tech_id]
            tech = roster.get(tech_id)
            slot_counts = {s.id: 0 for s in slots}
            cat_counts = {c: 0 for c in categories}
            working = 0
            for a in rows:
                if a.slot_id:
                    slot_counts[a.slot_id] += 1
                    working += 1
                else:
                    cat_counts[a.category] = cat_counts.get(a.category, 0) + 1
            w.writerow(
                [number, tech.display_name, tech.division, "-".join(tech.fixed_off)]
                + [slot_counts[s.id] or "" for s in slots]
                + [working] + [cat_counts.get(c, 0) for c in categories] + [len(rows)]
            )
        # Average headcount per slot per day, comparable with S4's Average Count row.
        averages = ["", "Average Count", "", ""]
        for s in slots:
            total = sum(1 for a in plan.assignments if a.slot_id == s.id)
            averages.append(round(total / len(plan.days), 1))
        w.writerow(averages)
    return path


def write_preview_html(plan: Plan, config: ShiftConfig, roster: Roster, path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    slots = config.slots
    by_date = plan.by_date()
    rows = []
    for day in plan.days:
        cells: dict[str, list[str]] = {s.id: [] for s in slots}
        offs: list[str] = []
        for a in sorted(by_date[day], key=lambda x: x.tech_id):
            tech = roster.get(a.tech_id)
            if a.slot_id:
                slot = config.slot(a.slot_id)
                window = _window(a.start or slot.start, slot.duration_min) if slot.is_flexy else ""
                cells[a.slot_id].append(_label(tech, a.category, window))
            else:
                offs.append(f"{tech.display_name} {a.category}")
        tds = "".join(
            f'<td style="background:{BAND_COLOURS.get(s.band, "#fff")}">'
            f'{html.escape(", ".join(cells[s.id]))}</td>'
            for s in slots
        )
        weekend = ' class="we"' if day.weekday() >= 5 else ""
        rows.append(
            f'<tr><th{weekend}>{weekday_name(day)[:3]}, {day.day} {day.strftime("%b")}</th>'
            f'{tds}<td style="background:{OFF_COLOUR}">{html.escape(", ".join(offs))}</td></tr>'
        )

    shortfalls = "".join(f"<li>{html.escape(s.describe())}</li>" for s in plan.shortfalls)
    warnings = "".join(f"<li>{html.escape(w)}</li>" for w in plan.warnings)
    problems = ""
    if shortfalls or warnings:
        problems = (
            f'<section><h2>Needs attention</h2><ul>{shortfalls}{warnings}</ul></section>'
        )
    headers = "".join(f"<th>{html.escape(s.label)}</th>" for s in slots)
    doc = f"""<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>S4 draft — {html.escape(plan.month)}</title>
<style>
  body {{ font-family: Arial, Helvetica, sans-serif; font-size: 12px; color: #4A4D59; margin: 16px; }}
  h1 {{ font-size: 18px; }}
  table {{ border-collapse: collapse; width: 100%; }}
  th, td {{ border: 1px solid #7C7F57; padding: 3px 4px; vertical-align: top; text-align: center; }}
  thead th {{ background: #EFEFE6; position: sticky; top: 0; }}
  tbody th {{ background: #EFEFE6; white-space: nowrap; }}
  tbody th.we {{ background: #F5C6C6; }}
  section {{ margin: 16px 0; }}
  li {{ margin: 2px 0; }}
</style></head><body>
<h1>S4 draft roster — {html.escape(plan.month)} · team {html.escape(str(config.team.get("name", "")))}</h1>
<p>Draft only. Review, then push with <code>s4autofill push</code>.</p>
{problems}
<table><thead><tr><th>Date</th>{headers}<th>Leaves/Offs</th></tr></thead>
<tbody>{"".join(rows)}</tbody></table>
</body></html>
"""
    path.write_text(doc)
    return path


def write_payloads(plan: Plan, config: ShiftConfig, roster: Roster, path: Path,
                   reason: str = "Monthly roster autofill") -> Path:
    """One JSON line per S4 form submission, ready for `push`."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        for batch in batch_assignments(plan):
            slot = config.slot(batch.slot_id) if batch.slot_id else None
            tech = roster.get(batch.tech_id)
            f.write(json.dumps({
                "tech_id": batch.tech_id,
                "tech_email": tech.email,
                "team_id": config.team.get("s4_team_id"),
                "category": batch.category,
                "slot_id": batch.slot_id or None,
                "shift_time": slot.label if slot else "",
                "start_date": s4_date(batch.start),
                "end_date": s4_date(batch.end),
                "start_iso": batch.start.isoformat(),
                "end_iso": batch.end.isoformat(),
                "days": batch.days,
                "time": batch.time or (slot.start if slot else config.rules.flexy_default_start),
                "duration_min": slot.duration_min if slot else config.rules.flexy_default_duration_min,
                "reason": reason,
            }) + "\n")
    return path


def write_extension_plan(plan: Plan, config: ShiftConfig, roster: Roster, path: Path,
                         reason: str = "Monthly roster autofill") -> Path:
    """Everything the browser extension needs, in one file.

    It carries the slot labels and the roster alongside the shift blocks,
    because that is what lets the extension work out which of S4's dropdown
    options means which shift without anybody typing the mapping out.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    assignments = []
    for batch in batch_assignments(plan):
        slot = config.slot(batch.slot_id) if batch.slot_id else None
        tech = roster.get(batch.tech_id)
        assignments.append({
            "tech_id": batch.tech_id,
            "tech_email": tech.email,
            "category": batch.category,
            "slot_id": batch.slot_id or None,
            "shift_time": slot.label if slot else "",
            "start_date": s4_date(batch.start),
            "end_date": s4_date(batch.end),
            "days": batch.days,
            "time": batch.time or (slot.start if slot else config.rules.flexy_default_start),
            "duration_min": slot.duration_min if slot else config.rules.flexy_default_duration_min,
            "reason": reason,
            "source": batch.source,
        })
    document = {
        "month": plan.month,
        # Carried so the extension can say "this month has gaps" before it
        # fills anything, rather than the gaps only existing in a terminal.
        "issues": {
            "shortfalls": [s.describe() for s in plan.shortfalls],
            "warnings": list(plan.warnings),
        },
        "generated": dt.datetime.now().isoformat(timespec="seconds"),
        "team": config.team.get("name", ""),
        "team_id": config.team.get("s4_team_id"),
        "form_name": "shift",
        "slots": [{"id": s.id, "label": s.label, "band": s.band} for s in config.slots],
        "categories": dict(config.categories),
        "techs": [
            {"id": t.id, "display_name": t.display_name, "email": t.email,
             "division": t.division}
            for t in roster.techs if t.active
        ],
        "assignments": assignments,
    }
    with open(path, "w") as f:
        json.dump(document, f, indent=2)
        f.write("\n")
    return path


def write_all(plan: Plan, config: ShiftConfig, roster: Roster, out_dir: Path) -> dict[str, Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    return {
        "schedule": write_schedule_csv(plan, config, roster, out_dir / "schedule.csv"),
        "grid": write_grid_csv(plan, config, roster, out_dir / "grid.csv"),
        "summary": write_summary_csv(plan, config, roster, out_dir / "summary.csv"),
        "preview": write_preview_html(plan, config, roster, out_dir / "preview.html"),
        "payloads": write_payloads(plan, config, roster, out_dir / "payloads.jsonl"),
        "extension": write_extension_plan(plan, config, roster, out_dir / "plan.json"),
    }


__all__ = [
    "Batch", "batch_assignments", "write_schedule_csv", "write_grid_csv",
    "write_summary_csv", "write_preview_html", "write_payloads", "write_extension_plan",
    "write_all",
]
