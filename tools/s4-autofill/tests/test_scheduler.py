import datetime as dt

from helpers import default_team, empty_input, make_config, make_roster, make_tech, wide_team
from s4autofill.model import MonthInput
from s4autofill.scheduler import build_plan


def plan_for(roster, month_input=None, config=None, month="2026-10"):
    return build_plan(config or make_config(), roster,
                      month_input or empty_input(month), month)


def test_every_tech_gets_a_row_for_every_day():
    roster = default_team()
    plan = plan_for(roster)
    assert len(plan.assignments) == 31 * len(roster.techs)
    for rows in plan.by_tech().values():
        assert len({r.date for r in rows}) == 31


def test_fixed_off_weekdays_are_never_worked():
    plan = plan_for(default_team())
    for row in plan.by_tech()["ann"]:
        if row.date.weekday() == 6:  # Sunday
            assert not row.is_working
            assert row.category == "OFF"


def test_dedicated_slot_owner_always_gets_their_slot():
    plan = plan_for(default_team())
    worked = [r for r in plan.by_tech()["dee"] if r.is_working]
    assert worked, "dee should work"
    assert {r.slot_id for r in worked} == {"own"}
    # and nobody else is ever put in it
    assert all(r.tech_id == "dee" for r in plan.assignments if r.slot_id == "own")


def test_coverage_minimums_are_met():
    config = make_config()
    plan = plan_for(default_team(), config=config)
    assert plan.shortfalls == []
    by_date = plan.by_date()
    for day, rows in by_date.items():
        for slot in config.assignable:
            got = sum(1 for r in rows if r.slot_id == slot.id)
            assert got >= slot.min, f"{day} {slot.id}: {got} < {slot.min}"


def test_division_minimum_is_respected():
    config = make_config()
    roster = default_team()
    plan = plan_for(roster, config=config)
    division = {t.id: t.division for t in roster.techs}
    for day, rows in plan.by_date().items():
        sa = sum(1 for r in rows if r.slot_id == "morn" and division[r.tech_id] == "SA")
        assert sa >= 1, f"{day}: no SA on the morning slot"


def test_rest_gap_is_never_violated():
    config = make_config()
    plan = plan_for(default_team(), config=config)
    for rows in plan.by_tech().values():
        previous_end = None
        for row in rows:
            if not row.is_working:
                previous_end = None
                continue
            slot = config.slot(row.slot_id)
            start = dt.datetime.combine(row.date, dt.time(*map(int, (row.start or slot.start).split(":"))))
            if previous_end is not None:
                assert start - previous_end >= dt.timedelta(hours=11)
            previous_end = start + dt.timedelta(minutes=slot.duration_min)


def test_avoid_slots_are_honoured():
    roster = make_roster(
        make_tech("ann", "SA", fixed_off=["Sunday"], avoid_slots=["night"]),
        make_tech("bob", "SM", fixed_off=["Sunday"]),
        make_tech("cat", "SA", fixed_off=["Saturday"]),
        make_tech("dee", "SM", fixed_off=["Saturday"]),
    )
    plan = plan_for(roster)
    assert all(r.slot_id != "night" for r in plan.by_tech()["ann"])


def test_night_budget_is_capped():
    config = make_config(max_nights_per_month_default=4)
    plan = plan_for(default_team(), config=config)
    for tech_id, rows in plan.by_tech().items():
        nights = sum(1 for r in rows if r.slot_id == "night")
        assert nights <= 4, f"{tech_id} worked {nights} nights"


def test_preference_wins_over_queue_position():
    """The tech who asked for a slot gets it over one who merely queued first."""
    roster = make_roster(
        make_tech("early", "SA", fixed_off=["Sunday"], prefs_submitted_at="2026-01-01T08:00:00"),
        make_tech("asker", "SM", fixed_off=["Sunday"], preferences=["night"],
                  prefs_submitted_at="2026-01-01T09:00:00"),
        make_tech("cat", "SA", fixed_off=["Saturday"]),
        make_tech("dee", "SM", fixed_off=["Saturday"]),
    )
    config = make_config(max_nights_per_month_default=31)
    plan = plan_for(roster, config=config)
    per_tech = plan.by_tech()
    asker_nights = sum(1 for r in per_tech["asker"] if r.slot_id == "night")
    early_nights = sum(1 for r in per_tech["early"] if r.slot_id == "night")
    assert asker_nights > early_nights


def test_fifo_rotates_between_equal_askers():
    """Two people who both asked for nights should end up sharing them."""
    roster = wide_team(
        ann={"preferences": ["night"]},
        bob={"preferences": ["night"]},
    )
    # 'dee' owns the dedicated slot in the fixture config; drop that here so the
    # contest is only about the night slot.
    roster.get("dee").fixed_slot = None
    config = make_config(division_min=False)
    plan = plan_for(roster, config=config)
    per_tech = plan.by_tech()
    nights = {tech: sum(1 for r in rows if r.slot_id == "night")
              for tech, rows in per_tech.items()}
    ann, bob = nights["ann"], nights["bob"]
    assert abs(ann - bob) <= 2, f"the two askers did not share: {nights}"
    others = [n for tech, n in nights.items() if tech not in {"ann", "bob"}]
    assert min(ann, bob) > sum(others) / len(others), \
        f"asking for nights should beat not asking: {nights}"


def test_asking_does_not_break_the_night_budget():
    """Wanting nights every day still stops at the monthly cap."""
    roster = wide_team(ann={"preferences": ["night"]})
    roster.get("dee").fixed_slot = None
    config = make_config(division_min=False, max_nights_per_month_default=6)
    plan = plan_for(roster, config=config)
    assert sum(1 for r in plan.by_tech()["ann"] if r.slot_id == "night") <= 6


def test_dated_leave_is_honoured_exactly():
    month_input = MonthInput(month="2026-10", leave={"ann": {"2026-10-07": "CL", "2026-10-08": "PV"}})
    plan = plan_for(default_team(), month_input)
    rows = {r.date.isoformat(): r for r in plan.by_tech()["ann"]}
    assert rows["2026-10-07"].category == "CL" and not rows["2026-10-07"].is_working
    assert rows["2026-10-08"].category == "PV" and not rows["2026-10-08"].is_working


def test_quota_leave_counts_are_spent():
    month_input = MonthInput(month="2026-10", targets={"ann": {"off_days": 5, "CL": 2}})
    plan = plan_for(default_team(), month_input)
    rows = plan.by_tech()["ann"]
    assert sum(1 for r in rows if r.category == "CL") == 2


def test_extra_off_days_are_granted():
    month_input = MonthInput(month="2026-10", targets={"ann": {"off_days": 10}})
    plan = plan_for(default_team(), month_input)
    offs = sum(1 for r in plan.by_tech()["ann"] if r.category == "OFF")
    assert offs == 10


def test_public_holiday_lands_on_a_declared_date():
    month_input = MonthInput(
        month="2026-10",
        public_holidays={"2026-10-02": "Gandhi Jayanti"},
        targets={"ann": {"off_days": 4, "PH": 1}},
    )
    plan = plan_for(default_team(), month_input)
    holiday = [r for r in plan.by_tech()["ann"] if r.category == "PH"]
    assert len(holiday) == 1
    assert holiday[0].date.isoformat() == "2026-10-02"


def test_joiner_is_not_scheduled_before_their_start_date():
    roster = default_team()
    roster.techs.append(make_tech("new", "SA", fixed_off=["Sunday"], joined="2026-10-15"))
    plan = plan_for(roster)
    for row in plan.by_tech()["new"]:
        if row.date < dt.date(2026, 10, 15):
            assert not row.is_working


def test_leaver_is_not_scheduled_after_their_last_day():
    roster = default_team()
    roster.get("eve").left = "2026-10-10"
    plan = plan_for(roster)
    for row in plan.by_tech()["eve"]:
        if row.date >= dt.date(2026, 10, 10):
            assert not row.is_working


def test_plan_is_deterministic():
    first = plan_for(default_team())
    second = plan_for(default_team())
    assert [(a.date, a.tech_id, a.slot_id) for a in first.assignments] == \
           [(a.date, a.tech_id, a.slot_id) for a in second.assignments]


def test_flexy_start_is_pushed_past_the_rest_gap():
    config = make_config()
    plan = plan_for(default_team(), config=config)
    for rows in plan.by_tech().values():
        for previous, row in zip(rows, rows[1:]):
            if previous.slot_id == "night" and row.slot_id == "flexy":
                assert row.start is not None and row.start >= "18:00"
