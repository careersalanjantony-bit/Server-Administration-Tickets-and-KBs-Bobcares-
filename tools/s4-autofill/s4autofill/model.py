"""Config objects: slots, rules, techs, and the month input that drives a plan."""

from __future__ import annotations

import datetime as dt
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .holidays import S4_HOLIDAYS
from .monthcal import WEEKDAYS, normalise_weekdays, weekday_index

CONFIG_DIR = Path(__file__).resolve().parent.parent / "config"


@dataclass(frozen=True)
class Slot:
    id: str
    label: str
    start: str
    duration_min: int
    band: str
    min: int
    target: int
    max: int
    division_min: dict[str, int] = field(default_factory=dict)
    dedicated: list[str] = field(default_factory=list)
    observed_avg: float = 0.0

    @property
    def is_flexy(self) -> bool:
        return self.band == "flexy"

    @property
    def is_night(self) -> bool:
        return self.band == "night"


@dataclass(frozen=True)
class Rules:
    min_rest_hours_between_shifts: int = 11
    max_consecutive_working_days: int = 6
    max_consecutive_nights: int = 5
    max_nights_per_month_default: int = 10
    stickiness_block_days: int = 3
    fill_order: tuple[str, ...] = ("night", "evening", "morning", "day")
    unassigned_go_to: str = "flexy"
    flexy_default_start: str = "01:00"
    flexy_default_duration_min: int = 480
    extra_off_placement: str = "spread"
    quota_leave_placement: str = "adjacent_to_off"
    spill_to_max: bool = True
    spill_order: tuple[str, ...] = ("morning", "day", "evening", "night")
    arbitrate_off_requests: bool = True


@dataclass
class Tech:
    id: str
    email: str
    division: str
    display_name: str = ""
    active: bool = True
    joined: str | None = None
    left: str | None = None
    tags: list[str] = field(default_factory=list)
    fixed_off: list[str] = field(default_factory=list)
    fixed_slot: str | None = None
    preferences: list[str] = field(default_factory=list)
    avoid_slots: list[str] = field(default_factory=list)
    prefs_submitted_at: str = "2999-01-01T00:00:00"
    flexy_start: str | None = None
    no_night_before_off: bool = False
    max_nights_per_month: int | None = None
    notes: str = ""

    def __post_init__(self) -> None:
        self.display_name = self.display_name or self.id
        self.fixed_off = normalise_weekdays(self.fixed_off) if self.fixed_off else []

    @property
    def fixed_off_indexes(self) -> set[int]:
        return {weekday_index(n) for n in self.fixed_off}

    def employed_on(self, day: dt.date) -> bool:
        """False before a joining date or on/after a leaving date."""
        if self.joined and day < dt.date.fromisoformat(self.joined):
            return False
        if self.left and day >= dt.date.fromisoformat(self.left):
            return False
        return True

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "display_name": self.display_name,
            "email": self.email,
            "division": self.division,
            "active": self.active,
            "joined": self.joined,
            "left": self.left,
            "tags": self.tags,
            "fixed_off": self.fixed_off,
            "fixed_slot": self.fixed_slot,
            "preferences": self.preferences,
            "avoid_slots": self.avoid_slots,
            "prefs_submitted_at": self.prefs_submitted_at,
            "flexy_start": self.flexy_start,
            "no_night_before_off": self.no_night_before_off,
            "max_nights_per_month": self.max_nights_per_month,
            "notes": self.notes,
        }


@dataclass
class ShiftConfig:
    team: dict[str, Any]
    slots: list[Slot]
    rules: Rules
    categories: dict[str, str]
    leave_categories: list[str]

    def __post_init__(self) -> None:
        # Every S4 holiday code (GJ, VJ, …) is a day off like PH, and a
        # category a plan may carry, whether or not shifts.json lists it.
        self.categories = dict(self.categories)
        self.leave_categories = list(self.leave_categories)
        for code, name in S4_HOLIDAYS.items():
            self.categories.setdefault(code, name)
            if code not in self.leave_categories:
                self.leave_categories.append(code)

    def slot(self, slot_id: str) -> Slot:
        for s in self.slots:
            if s.id == slot_id:
                return s
        raise KeyError(f"unknown slot id {slot_id!r}")

    @property
    def flexy(self) -> Slot:
        return self.slot(self.rules.unassigned_go_to)

    @property
    def assignable(self) -> list[Slot]:
        """Every slot the scheduler may place someone in, Flexy excluded."""
        return [s for s in self.slots if not s.is_flexy]


@dataclass
class Roster:
    divisions: dict[str, dict[str, str]]
    techs: list[Tech]

    def get(self, tech_id: str) -> Tech:
        for t in self.techs:
            if t.id == tech_id:
                return t
        raise KeyError(f"no tech with id {tech_id!r}")

    def has(self, tech_id: str) -> bool:
        return any(t.id == tech_id for t in self.techs)

    def active_on(self, day: dt.date) -> list[Tech]:
        return [t for t in self.techs if t.active and t.employed_on(day)]

    def to_dict(self, comment: str = "") -> dict[str, Any]:
        return {
            "_comment": comment,
            "divisions": self.divisions,
            "techs": [t.to_dict() for t in self.techs],
        }


@dataclass
class MonthInput:
    """Per-month answers: leave days, quotas and public holidays."""

    month: str
    public_holidays: dict[str, str] = field(default_factory=dict)   # 'YYYY-MM-DD' -> name
    leave: dict[str, dict[str, str]] = field(default_factory=dict)  # tech -> date -> category
    unavoidable: dict[str, list[str]] = field(default_factory=dict)  # tech -> dates that stand
    targets: dict[str, dict[str, int]] = field(default_factory=dict)  # tech -> {off_days, cl, ph,...}
    notes: str = ""

    def leave_for(self, tech_id: str, day: dt.date) -> str | None:
        return self.leave.get(tech_id, {}).get(day.isoformat())

    def to_dict(self) -> dict[str, Any]:
        return {
            "month": self.month,
            "public_holidays": self.public_holidays,
            "targets": self.targets,
            "leave": self.leave,
            "unavoidable": self.unavoidable,
            "notes": self.notes,
        }


def _read_json(path: Path) -> dict[str, Any]:
    with open(path) as f:
        return json.load(f)


def load_shift_config(path: Path | None = None) -> ShiftConfig:
    raw = _read_json(path or CONFIG_DIR / "shifts.json")
    slots = [
        Slot(
            id=s["id"], label=s["label"], start=s["start"], duration_min=s["duration_min"],
            band=s["band"], min=s["min"], target=s["target"], max=s["max"],
            division_min=s.get("division_min", {}), dedicated=s.get("dedicated", []),
            observed_avg=s.get("observed_avg", 0.0),
        )
        for s in raw["slots"]
    ]
    rules_raw = dict(raw.get("rules", {}))
    rules_raw["fill_order"] = tuple(rules_raw.get("fill_order", Rules.fill_order))
    rules_raw["spill_order"] = tuple(rules_raw.get("spill_order", Rules.spill_order))
    rules = Rules(**rules_raw)
    cfg = ShiftConfig(
        team=raw["team"], slots=slots, rules=rules,
        categories=raw.get("categories", {}), leave_categories=raw.get("leave_categories", []),
    )
    cfg.slot(rules.unassigned_go_to)  # fail fast if the overflow slot is missing
    return cfg


def load_roster(path: Path | None = None) -> Roster:
    raw = _read_json(path or CONFIG_DIR / "roster.json")
    known = {f.name for f in Tech.__dataclass_fields__.values()}
    techs = [Tech(**{k: v for k, v in t.items() if k in known}) for t in raw["techs"]]
    seen: set[str] = set()
    for t in techs:
        if t.id in seen:
            raise ValueError(f"duplicate tech id in roster: {t.id}")
        seen.add(t.id)
    return Roster(divisions=raw.get("divisions", {}), techs=techs)


def save_roster(roster: Roster, path: Path | None = None, comment: str = "") -> Path:
    target = path or CONFIG_DIR / "roster.json"
    existing_comment = ""
    if target.exists():
        existing_comment = _read_json(target).get("_comment", "")
    with open(target, "w") as f:
        json.dump(roster.to_dict(comment or existing_comment), f, indent=2)
        f.write("\n")
    return target


def load_month_input(month: str, path: Path | None = None) -> MonthInput:
    target = path or CONFIG_DIR / "months" / f"{month}.json"
    if not Path(target).exists():
        return MonthInput(month=month)
    raw = _read_json(Path(target))
    return MonthInput(
        month=raw.get("month", month),
        public_holidays=raw.get("public_holidays", {}),
        leave=raw.get("leave", {}),
        unavoidable=raw.get("unavoidable", {}),
        targets=raw.get("targets", {}),
        notes=raw.get("notes", ""),
    )


def save_month_input(data: MonthInput, path: Path | None = None) -> Path:
    target = Path(path or CONFIG_DIR / "months" / f"{data.month}.json")
    target.parent.mkdir(parents=True, exist_ok=True)
    with open(target, "w") as f:
        json.dump(data.to_dict(), f, indent=2)
        f.write("\n")
    return target


__all__ = [
    "WEEKDAYS", "Slot", "Rules", "Tech", "ShiftConfig", "Roster", "MonthInput",
    "load_shift_config", "load_roster", "save_roster", "load_month_input", "save_month_input",
    "CONFIG_DIR",
]
