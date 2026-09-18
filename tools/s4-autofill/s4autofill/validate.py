"""Checks that run before anything is pushed to S4.

Errors block a push; warnings are things the lead should look at but that do
not make the roster wrong.
"""

from __future__ import annotations

import datetime as dt
from dataclasses import dataclass

from .model import MonthInput, Roster, ShiftConfig
from .monthcal import month_days, shift_window
from .scheduler import Plan


@dataclass
class Issue:
    level: str      # "error" | "warning"
    code: str
    subject: str
    message: str

    def format(self) -> str:
        return f"[{self.level.upper():7}] {self.code:22} {self.subject:14} {self.message}"


def check_roster(roster: Roster, config: ShiftConfig) -> list[Issue]:
    issues: list[Issue] = []
    slot_ids = {s.id for s in config.slots}
    emails: dict[str, str] = {}
    for tech in roster.techs:
        if not tech.active:
            continue
        if tech.division not in roster.divisions:
            issues.append(Issue("error", "unknown-division", tech.id,
                                f"division {tech.division!r} is not defined in the roster"))
        elif tech.division == "UNASSIGNED":
            issues.append(Issue("warning", "unassigned-division", tech.id,
                                "no SA / SM division set — division minimums cannot count them"))
        if not tech.fixed_off:
            issues.append(Issue("warning", "no-fixed-off", tech.id,
                                "no fixed off days — they will be scheduled 7 days a week"))
        if tech.fixed_slot and tech.fixed_slot not in slot_ids:
            issues.append(Issue("error", "unknown-slot", tech.id,
                                f"fixed_slot {tech.fixed_slot!r} is not a known slot"))
        if tech.fixed_slot:
            slot = config.slot(tech.fixed_slot)
            if tech.id not in slot.dedicated:
                issues.append(Issue("error", "dedication-mismatch", tech.id,
                                    f"fixed_slot is {slot.id} but that slot's 'dedicated' list "
                                    f"is {slot.dedicated or '[]'} — the two must agree"))
        for pref in tech.preferences:
            if pref not in slot_ids:
                issues.append(Issue("error", "unknown-slot", tech.id,
                                    f"preference {pref!r} is not a known slot"))
        if set(tech.preferences) & set(tech.avoid_slots):
            issues.append(Issue("error", "contradictory-prefs", tech.id,
                                "the same slot appears in both preferences and avoid_slots"))
        if tech.email in emails:
            issues.append(Issue("error", "duplicate-email", tech.id,
                                f"shares {tech.email} with {emails[tech.email]}"))
        emails[tech.email] = tech.id
    for slot in config.slots:
        for tech_id in slot.dedicated:
            if not roster.has(tech_id):
                issues.append(Issue("error", "unknown-tech", slot.id,
                                    f"dedicated to {tech_id!r}, who is not in the roster"))
            elif not roster.get(tech_id).active:
                issues.append(Issue("error", "inactive-dedicated", slot.id,
                                    f"dedicated to {tech_id!r}, who is marked inactive"))
        if slot.min > slot.target or slot.target > slot.max:
            issues.append(Issue("error", "bad-bounds", slot.id,
                                f"min {slot.min} / target {slot.target} / max {slot.max} "
                                f"must be non-decreasing"))
    return issues


def check_plan(plan: Plan, roster: Roster, config: ShiftConfig,
               month_input: MonthInput) -> list[Issue]:
    issues: list[Issue] = []
    rules = config.rules
    expected_days = len(month_days(plan.year, plan.mon))

    for sf in plan.shortfalls:
        issues.append(Issue("error", "coverage-shortfall", sf.slot_id, sf.describe()))
    for warning in plan.warnings:
        subject, _, rest = warning.partition(": ")
        issues.append(Issue("warning", "scheduler-note", subject, rest or warning))

    per_tech = plan.by_tech()
    for tech_id, rows in sorted(per_tech.items()):
        tech = roster.get(tech_id)

        if len(rows) != expected_days:
            issues.append(Issue("error", "day-count", tech_id,
                                f"{len(rows)} rows for a {expected_days}-day month"))
        dates = [r.date for r in rows]
        if len(set(dates)) != len(dates):
            issues.append(Issue("error", "double-booked", tech_id,
                                "more than one entry on the same date"))

        # Rest between consecutive shifts.
        nights = 0
        run = consecutive_nights = 0
        longest_run, longest_run_end = 0, None
        previous_end: dt.datetime | None = None
        previous_label: str = ""
        for row in rows:
            if not row.is_working:
                run = consecutive_nights = 0
                previous_end = None
                continue
            run += 1
            slot = config.slot(row.slot_id)
            if slot.is_night:
                nights += 1
                consecutive_nights += 1
            else:
                consecutive_nights = 0
            start, end = shift_window(row.date, row.start or slot.start, slot.duration_min)
            if previous_end is not None:
                gap = start - previous_end
                if gap < dt.timedelta(hours=rules.min_rest_hours_between_shifts):
                    issues.append(Issue("error", "short-rest", tech_id,
                                        f"{previous_label} -> {row.date} {slot.label} "
                                        f"leaves {gap} rest, minimum is "
                                        f"{rules.min_rest_hours_between_shifts}h"))
            if run > longest_run:
                longest_run, longest_run_end = run, row.date
            if consecutive_nights > rules.max_consecutive_nights:
                issues.append(Issue("error", "night-run", tech_id,
                                    f"{consecutive_nights} night shifts in a row ending {row.date}"))
            previous_end, previous_label = end, f"{row.date} {slot.label}"

        if longest_run > rules.max_consecutive_working_days:
            issues.append(Issue("warning", "long-run", tech_id,
                                f"works {longest_run} days in a row (to {longest_run_end}); "
                                f"limit is {rules.max_consecutive_working_days}"))

        if tech.no_night_before_off:
            for previous, following in zip(rows, rows[1:]):
                if (previous.is_working and not following.is_working
                        and config.slot(previous.slot_id).is_night):
                    issues.append(Issue("error", "night-before-off", tech_id,
                                        f"night shift on {previous.date} runs into their "
                                        f"{following.category} on {following.date}"))

        budget = (rules.max_nights_per_month_default
                  if tech.max_nights_per_month is None else tech.max_nights_per_month)
        if nights > budget:
            issues.append(Issue("error", "night-budget", tech_id,
                                f"{nights} night shifts this month, budget is {budget}"))

        # Did the plan honour what the tech asked for on the intake sheet?
        targets = month_input.targets.get(tech_id, {})
        actual: dict[str, int] = {}
        for row in rows:
            if not row.is_working:
                actual[row.category] = actual.get(row.category, 0) + 1
        wanted_off = targets.get("off_days")
        if wanted_off is not None and actual.get("OFF", 0) < wanted_off:
            issues.append(Issue("warning", "off-days-short", tech_id,
                                f"asked for {wanted_off} off days, plan gives {actual.get('OFF', 0)}"))
        for category, count in targets.items():
            if category == "off_days":
                continue
            if actual.get(category, 0) < count:
                issues.append(Issue("warning", "leave-short", tech_id,
                                    f"asked for {count} {category}, plan gives "
                                    f"{actual.get(category, 0)}"))

        # Did anyone get a shift they explicitly said they cannot do?
        for row in rows:
            if row.is_working and row.slot_id in tech.avoid_slots:
                issues.append(Issue("error", "avoided-slot", tech_id,
                                    f"{row.date} is {row.slot_id}, which they asked to avoid"))

        granted = sum(1 for r in rows if r.is_working and r.slot_id in tech.preferences)
        worked = sum(1 for r in rows if r.is_working)
        if tech.preferences and worked and granted == 0:
            issues.append(Issue("warning", "preference-unmet", tech_id,
                                f"asked for {'/'.join(tech.preferences)} and got it on 0 of "
                                f"{worked} working days"))
    return issues


def validate(plan: Plan, roster: Roster, config: ShiftConfig,
             month_input: MonthInput) -> list[Issue]:
    return check_roster(roster, config) + check_plan(plan, roster, config, month_input)


def summarise(issues: list[Issue]) -> tuple[int, int]:
    errors = sum(1 for i in issues if i.level == "error")
    return errors, len(issues) - errors


__all__ = ["Issue", "check_roster", "check_plan", "validate", "summarise"]
