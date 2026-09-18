import datetime as dt

from helpers import default_team, empty_input, make_config
from s4autofill.model import MonthInput
from s4autofill.scheduler import build_plan
from s4autofill.validate import check_plan, check_roster, summarise, validate


def codes(issues):
    return {i.code for i in issues}


def test_a_clean_roster_and_plan_raise_no_errors():
    config, roster = make_config(), default_team()
    month_input = empty_input()
    plan = build_plan(config, roster, month_input, "2026-10")
    errors, _ = summarise(validate(plan, roster, config, month_input))
    assert errors == 0


def test_missing_fixed_off_is_flagged():
    config, roster = make_config(), default_team()
    roster.get("ann").fixed_off = []
    assert "no-fixed-off" in codes(check_roster(roster, config))


def test_unknown_preference_slot_is_an_error():
    config, roster = make_config(), default_team()
    roster.get("ann").preferences = ["graveyard"]
    issues = check_roster(roster, config)
    assert "unknown-slot" in codes(issues)
    assert any(i.level == "error" for i in issues if i.code == "unknown-slot")


def test_contradictory_preferences_are_an_error():
    config, roster = make_config(), default_team()
    roster.get("ann").preferences = ["night"]
    roster.get("ann").avoid_slots = ["night"]
    assert "contradictory-prefs" in codes(check_roster(roster, config))


def test_duplicate_email_is_an_error():
    config, roster = make_config(), default_team()
    roster.get("bob").email = roster.get("ann").email
    assert "duplicate-email" in codes(check_roster(roster, config))


def test_dedication_must_agree_with_the_slot():
    config, roster = make_config(), default_team()
    roster.get("ann").fixed_slot = "morn"  # morn is not dedicated to anyone
    assert "dedication-mismatch" in codes(check_roster(roster, config))


def test_slot_bounds_must_be_ordered():
    config = make_config()
    bad = [s for s in config.slots if s.id == "morn"][0]
    object.__setattr__(bad, "min", 5)
    assert "bad-bounds" in codes(check_roster(default_team(), config))


def test_a_short_leave_allocation_is_reported():
    config, roster = make_config(), default_team()
    # Ask for more casual leave than there are days to place it on.
    month_input = MonthInput(month="2026-10", targets={"ann": {"off_days": 4, "CL": 40}})
    plan = build_plan(config, roster, month_input, "2026-10")
    issues = check_plan(plan, roster, config, month_input)
    assert "leave-short" in codes(issues)


def test_avoided_slot_in_a_plan_is_an_error():
    config, roster = make_config(), default_team()
    month_input = empty_input()
    plan = build_plan(config, roster, month_input, "2026-10")
    # Retro-fit an avoid after planning: validation must still catch it.
    worked = next(r for r in plan.by_tech()["ann"] if r.is_working)
    roster.get("ann").avoid_slots = [worked.slot_id]
    assert "avoided-slot" in codes(check_plan(plan, roster, config, month_input))


def test_double_booking_is_an_error():
    config, roster = make_config(), default_team()
    month_input = empty_input()
    plan = build_plan(config, roster, month_input, "2026-10")
    duplicate = plan.assignments[0]
    plan.assignments.append(duplicate)
    issues = check_plan(plan, roster, config, month_input)
    assert "double-booked" in codes(issues) or "day-count" in codes(issues)


def test_short_rest_is_an_error():
    config, roster = make_config(), default_team()
    month_input = empty_input()
    plan = build_plan(config, roster, month_input, "2026-10")
    rows = plan.by_tech()["ann"]
    # Force a night immediately followed by a morning.
    rows[0].slot_id, rows[0].category, rows[0].start = "night", "W", "23:00"
    rows[1].slot_id, rows[1].category, rows[1].start = "morn", "W", "07:00"
    assert "short-rest" in codes(check_plan(plan, roster, config, month_input))
