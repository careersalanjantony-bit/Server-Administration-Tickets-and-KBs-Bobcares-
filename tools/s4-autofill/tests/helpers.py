"""A small fixed team, so tests do not depend on the live roster."""

from __future__ import annotations

import json
from pathlib import Path

from s4autofill.model import MonthInput, Roster, Rules, ShiftConfig, Slot, Tech

SLOTS = [
    Slot(id="morn", label="07:00am-03:00pm", start="07:00", duration_min=480, band="morning",
         min=1, target=2, max=3, division_min={"SA": 1}),
    Slot(id="eve", label="03:00pm-11:00pm", start="15:00", duration_min=480, band="evening",
         min=1, target=2, max=3),
    Slot(id="night", label="11:00pm-07:00am", start="23:00", duration_min=480, band="night",
         min=1, target=1, max=2),
    Slot(id="own", label="09:00am-05:00pm", start="09:00", duration_min=480, band="day",
         min=0, target=1, max=1, dedicated=["dee"]),
    Slot(id="flexy", label="Flexy", start="01:00", duration_min=480, band="flexy",
         min=0, target=0, max=99),
]

CATEGORIES = {"W": "Working Day", "OFF": "Off", "CL": "Casual Leave", "PH": "Public Holiday",
              "PV": "Paid Vacation", "ITW": "In Team Work"}
LEAVE = ["OFF", "CL", "PH", "PV"]


def make_config(division_min: bool = True, **rule_overrides) -> ShiftConfig:
    slots = list(SLOTS)
    if not division_min:
        slots = [
            Slot(**{**s.__dict__, "division_min": {}}) if s.division_min else s
            for s in slots
        ]
    return ShiftConfig(
        team={"name": "Test", "s4_team_id": 1},
        slots=slots,
        rules=Rules(**rule_overrides),
        categories=dict(CATEGORIES),
        leave_categories=list(LEAVE),
    )


def make_tech(tech_id: str, division: str = "SA", **kwargs) -> Tech:
    kwargs.setdefault("email", f"{tech_id}@example.com")
    return Tech(id=tech_id, division=division, **kwargs)


def make_roster(*techs: Tech) -> Roster:
    return Roster(divisions={"SA": {"label": "SA"}, "SM": {"label": "SM"}}, techs=list(techs))


def default_team() -> Roster:
    return make_roster(
        make_tech("ann", "SA", fixed_off=["Sunday"], prefs_submitted_at="2026-01-01T09:00:00"),
        make_tech("bob", "SM", fixed_off=["Sunday"], prefs_submitted_at="2026-01-01T09:01:00"),
        make_tech("cat", "SA", fixed_off=["Saturday"], prefs_submitted_at="2026-01-01T09:02:00"),
        make_tech("dee", "SM", fixed_off=["Saturday"], fixed_slot="own",
                  prefs_submitted_at="2026-01-01T09:03:00"),
        make_tech("eve", "SA", fixed_off=["Monday"], prefs_submitted_at="2026-01-01T09:04:00"),
        make_tech("fay", "SM", fixed_off=["Monday"], prefs_submitted_at="2026-01-01T09:05:00"),
    )


def wide_team(**per_tech_kwargs) -> Roster:
    """Eight techs with staggered days off.

    Big enough that no slot is forced onto one person, which is what you need
    to see the preference queue actually make a choice.
    """
    offs = ["Sunday", "Monday", "Tuesday", "Wednesday",
            "Thursday", "Friday", "Saturday", "Sunday"]
    names = ["ann", "bob", "cid", "dee", "eli", "fay", "gus", "hal"]
    techs = []
    for i, (name, off) in enumerate(zip(names, offs)):
        techs.append(make_tech(
            name, "SA" if i % 2 == 0 else "SM", fixed_off=[off],
            prefs_submitted_at=f"2026-01-01T09:{i:02d}:00",
            **per_tech_kwargs.get(name, {}),
        ))
    return make_roster(*techs)


def empty_input(month: str = "2026-10") -> MonthInput:
    return MonthInput(month=month)


def write_shifts_file(path: Path, config: ShiftConfig | None = None) -> Path:
    """Serialise a test config so CLI commands can be pointed at it."""
    config = config or make_config()
    rules = dict(vars(config.rules))
    rules["fill_order"] = list(rules["fill_order"])
    rules["spill_order"] = list(rules["spill_order"])
    path.write_text(json.dumps({
        "team": config.team,
        "slots": [
            {"id": s.id, "label": s.label, "start": s.start, "duration_min": s.duration_min,
             "band": s.band, "min": s.min, "target": s.target, "max": s.max,
             "division_min": s.division_min, "dedicated": s.dedicated}
            for s in config.slots
        ],
        "rules": rules,
        "categories": config.categories,
        "leave_categories": config.leave_categories,
    }, indent=2))
    return path
