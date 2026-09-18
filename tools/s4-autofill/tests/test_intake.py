import csv

import pytest
from helpers import default_team, make_config
from s4autofill.intake import fixed_off_count, holidays_from_args, parse_leave_dates, read_intake, write_intake


def filled_sheet(tmp_path, roster, config, rows_update):
    path = tmp_path / "intake.csv"
    write_intake(roster, config, "2026-10", path)
    rows = list(csv.DictReader(open(path)))
    for row in rows:
        row.update(rows_update.get(row["tech_id"], {}))
    with open(path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=rows[0].keys())
        writer.writeheader()
        writer.writerows(rows)
    return path


def test_blank_sheet_prefills_the_fixed_off_count(tmp_path):
    roster, config = default_team(), make_config()
    path = write_intake(roster, config, "2026-10", tmp_path / "intake.csv")
    rows = {r["tech_id"]: r for r in csv.DictReader(open(path))}
    # October 2026 has four Sundays
    assert rows["ann"]["total_off_days"] == "4"
    assert rows["ann"]["fixed_off"] == "Sunday"


def test_reading_a_filled_sheet_collects_quotas(tmp_path):
    roster, config = default_team(), make_config()
    path = filled_sheet(tmp_path, roster, config, {
        "ann": {"cl_days": "2", "public_holiday_days": "1", "total_off_days": "6"},
    })
    month_input, _ = read_intake(path, roster, config, "2026-10")
    assert month_input.targets["ann"] == {"off_days": 6, "CL": 2, "PH": 1}


def test_reading_a_filled_sheet_updates_preferences(tmp_path):
    roster, config = default_team(), make_config()
    path = filled_sheet(tmp_path, roster, config, {
        "ann": {"preference_1": "night", "preference_2": "eve",
                "avoid_slots": "morn", "prefs_submitted_at": "2026-09-20T09:00:00"},
    })
    read_intake(path, roster, config, "2026-10")
    tech = roster.get("ann")
    assert tech.preferences == ["night", "eve"]
    assert tech.avoid_slots == ["morn"]
    assert tech.prefs_submitted_at == "2026-09-20T09:00:00"


def test_apply_to_roster_false_leaves_the_roster_alone(tmp_path):
    roster, config = default_team(), make_config()
    path = filled_sheet(tmp_path, roster, config, {"ann": {"preference_1": "night"}})
    read_intake(path, roster, config, "2026-10", apply_to_roster=False)
    assert roster.get("ann").preferences == []


def test_dated_leave_is_parsed_in_both_forms(tmp_path):
    roster, config = default_team(), make_config()
    path = filled_sheet(tmp_path, roster, config, {
        "ann": {"leave_dates": "2026-10-05:CL; 12:PH"},
    })
    month_input, _ = read_intake(path, roster, config, "2026-10")
    assert month_input.leave["ann"] == {"2026-10-05": "CL", "2026-10-12": "PH"}


def test_unknown_tech_is_rejected(tmp_path):
    roster, config = default_team(), make_config()
    path = filled_sheet(tmp_path, roster, config, {})
    with open(path, "a") as f:
        f.write("ghost,ghost,SA,yes,Sunday,,,,,,4,0,0,0,0,0,0,0,,\n")
    with pytest.raises(ValueError, match="not in the roster"):
        read_intake(path, roster, config, "2026-10")


def test_unknown_slot_in_a_preference_is_rejected(tmp_path):
    roster, config = default_team(), make_config()
    path = filled_sheet(tmp_path, roster, config, {"ann": {"preference_1": "graveyard"}})
    with pytest.raises(ValueError, match="unknown slot"):
        read_intake(path, roster, config, "2026-10")


def test_asking_for_fewer_offs_than_the_pattern_gives_warns(tmp_path):
    roster, config = default_team(), make_config()
    path = filled_sheet(tmp_path, roster, config, {"ann": {"total_off_days": "1"}})
    _, warnings = read_intake(path, roster, config, "2026-10")
    assert any("already gives 4" in w for w in warnings)


def test_leave_date_outside_the_month_is_rejected():
    with pytest.raises(ValueError, match="outside"):
        parse_leave_dates("2026-11-03:CL", 2026, 10, "ann")


def test_fixed_off_count_counts_both_weekdays():
    roster = default_team()
    roster.get("ann").fixed_off = ["Saturday", "Sunday"]
    assert fixed_off_count(roster.get("ann"), 2026, 10) == 9


def test_holiday_arguments_are_parsed():
    assert holidays_from_args(["2026-10-02=Gandhi Jayanti"]) == {"2026-10-02": "Gandhi Jayanti"}
