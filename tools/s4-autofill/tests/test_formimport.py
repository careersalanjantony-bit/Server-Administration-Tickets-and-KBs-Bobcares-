import datetime as dt
import zipfile
from pathlib import Path

import pytest
from helpers import default_team, empty_input, make_config, make_roster, make_tech
from s4autofill.formimport import (
    Submission, apply_suggestions, parse_dates, read_notes, read_submissions, to_month_input,
)
from s4autofill.scheduler import build_plan
from s4autofill.xlsxread import read_rows

FIXTURE = Path(__file__).parent / "data" / "off-form-september.csv"


def kinds(suggestions, tech):
    return {s.kind for s in suggestions if s.tech == tech}


def note(tech, text):
    return [Submission(tech=tech, sequence=1, notes=text)]


# ------------------------------------------------------------------ dates

def test_dates_with_month_name_and_weekday():
    assert parse_dates("September 3 Thursday, September 11 Friday", 2026, 9) == \
        [dt.date(2026, 9, 3), dt.date(2026, 9, 11)]


def test_bare_day_numbers_use_the_target_month():
    assert parse_dates("4,5,9", 2026, 9) == \
        [dt.date(2026, 9, 4), dt.date(2026, 9, 5), dt.date(2026, 9, 9)]


def test_duplicate_dates_are_collapsed():
    assert parse_dates("September 3, September 3", 2026, 9) == [dt.date(2026, 9, 3)]


def test_impossible_dates_are_dropped():
    assert parse_dates("February 31, September 5", 2026, 9) == [dt.date(2026, 9, 5)]


# ------------------------------------------------------------ reading the sheet

def test_reads_every_submission():
    submissions, _, _ = read_submissions(FIXTURE, "2026-09")
    assert len(submissions) == 18


def test_submissions_come_back_in_queue_order():
    submissions, _, _ = read_submissions(FIXTURE, "2026-09")
    assert [s.sequence for s in submissions] == sorted(s.sequence for s in submissions)
    assert submissions[0].tech == "annet.pj"      # ID 2 == 2, first in
    assert submissions[-1].tech == "ameer.ms"     # ID 2 == 19, last in


def test_holiday_is_read_out_of_the_column_header():
    _, holidays, _ = read_submissions(FIXTURE, "2026-09")
    assert holidays == {"2026-08-15": "Independence Day"}


def test_off_and_leave_days_are_separated():
    submissions, _, _ = read_submissions(FIXTURE, "2026-09")
    akhil = next(s for s in submissions if s.tech == "akhil.ep")
    assert len(akhil.off_days) == 9
    assert akhil.leave_days == [dt.date(2026, 9, 1)]


def test_a_sheet_without_a_tech_column_is_rejected(tmp_path):
    path = tmp_path / "bad.csv"
    path.write_text("ID,Something Else\n1,x\n")
    with pytest.raises(ValueError, match="Tech Name"):
        read_submissions(path, "2026-09")


# ----------------------------------------------- reading the free-text notes
# Each of these was a real false positive against the team's September notes.

def test_afternoon_is_not_read_as_the_word_no():
    """'4-off 1-afternoon 6-morning' must not ban mornings."""
    assert kinds(read_notes(note("nischitha.ns", "4-off 1-afternoon 6-morning 10-off")),
                 "nischitha.ns") == set()


def test_no_night_shift_morning_preferred_does_not_ban_mornings():
    """'No night shift morning shift preferred' bans nights, not mornings."""
    found = kinds(read_notes(note("anoop.g", "Saturday and Sunday off No night shift "
                                             "morning shift preferred")), "anoop.g")
    assert "avoid_nights" in found
    assert "prefer_mornings" in found
    assert "avoid_mornings" not in found


def test_ok_with_nights_is_not_read_as_avoiding_them():
    """'I am ok with night shifts ... No night shift before off days' is a
    before-off rule, not a refusal of nights."""
    found = kinds(read_notes(note("kuriakose.j",
                                  "I am ok with night shifts, reduce afternoon shifts if "
                                  "possible. No night shift before off days.")), "kuriakose.j")
    assert found == {"no_night_before_off"}


def test_softened_wording_is_read_as_fewer_not_never():
    found = kinds(read_notes(note("alan.j", "please don't assign me night shifts as much "
                                            "as possible")), "alan.j")
    assert found == {"fewer_nights"}


def test_hard_wording_is_read_as_never():
    assert kinds(read_notes(note("akshay.b", "Please avoid night shift")), "akshay.b") \
        == {"avoid_nights"}


def test_offs_after_nights_is_the_before_off_rule():
    found = kinds(read_notes(note("alan.j", "Please avoid scheduling offs immediately "
                                            "after night shifts")), "alan.j")
    assert "no_night_before_off" in found


def test_evening_preference_is_picked_up():
    found = kinds(read_notes(note("sidharth.ps", "Less night shift. Evening shift "
                                                 "preferred more.")), "sidharth.ps")
    assert found == {"fewer_nights", "prefer_evenings"}


def test_an_empty_note_suggests_nothing():
    assert read_notes(note("ann", "")) == []


# --------------------------------------------------------------- applying them

def test_applying_suggestions_sets_roster_fields():
    roster, config = default_team(), make_config()
    suggestions = read_notes([
        Submission(tech="ann", sequence=1, notes="Please avoid night shift"),
        Submission(tech="bob", sequence=2, notes="No night shift before off days."),
        Submission(tech="cat", sequence=3, notes="Less night shifts"),
    ])
    apply_suggestions(suggestions, roster, config, fewer_nights_cap=3)
    assert "night" in roster.get("ann").avoid_slots
    assert roster.get("bob").no_night_before_off is True
    assert roster.get("cat").max_nights_per_month == 3


def test_applying_ignores_someone_not_in_the_roster():
    roster, config = default_team(), make_config()
    suggestions = read_notes(note("ghost", "Please avoid night shift"))
    assert apply_suggestions(suggestions, roster, config) == []


# ------------------------------------------------------------- the month input

def test_queue_position_follows_submission_order():
    roster, config = default_team(), make_config()
    submissions = [
        Submission(tech="cat", sequence=2),
        Submission(tech="ann", sequence=7),
    ]
    to_month_input(submissions, roster, config, "2026-10", {})
    assert roster.get("cat").prefs_submitted_at < roster.get("ann").prefs_submitted_at


def test_off_and_leave_dates_become_month_input():
    roster, config = default_team(), make_config()
    submissions = [Submission(tech="ann", sequence=1,
                              off_days=[dt.date(2026, 10, 5)],
                              leave_days=[dt.date(2026, 10, 9)])]
    month_input, _ = to_month_input(submissions, roster, config, "2026-10", {})
    assert month_input.leave["ann"] == {"2026-10-05": "OFF", "2026-10-09": "CL"}
    assert month_input.targets["ann"]["CL"] == 1


def test_dates_outside_the_month_are_warned_not_applied():
    roster, config = default_team(), make_config()
    submissions = [Submission(tech="ann", sequence=1, off_days=[dt.date(2026, 11, 5)])]
    month_input, warnings = to_month_input(submissions, roster, config, "2026-10", {})
    assert "ann" not in month_input.leave
    assert any("outside" in w for w in warnings)


def test_a_submission_from_someone_not_in_the_roster_is_warned():
    roster, config = default_team(), make_config()
    _, warnings = to_month_input([Submission(tech="ghost", sequence=1)],
                                 roster, config, "2026-10", {})
    assert any("not in the roster" in w for w in warnings)


def test_imported_month_plans_and_honours_the_dates():
    roster, config = default_team(), make_config()
    submissions = [Submission(tech="ann", sequence=1,
                              off_days=[dt.date(2026, 10, 6)],
                              leave_days=[dt.date(2026, 10, 9)])]
    month_input, _ = to_month_input(submissions, roster, config, "2026-10", {})
    plan = build_plan(config, roster, month_input, "2026-10")
    rows = {r.date.isoformat(): r for r in plan.by_tech()["ann"]}
    assert rows["2026-10-06"].category == "OFF" and not rows["2026-10-06"].is_working
    assert rows["2026-10-09"].category == "CL"


# ------------------------------------------------------------------- the rule

def test_no_night_before_off_is_enforced():
    roster = make_roster(
        make_tech("ann", "SA", fixed_off=["Sunday"], no_night_before_off=True),
        make_tech("bob", "SM", fixed_off=["Sunday"]),
        make_tech("cid", "SA", fixed_off=["Saturday"]),
        make_tech("dee", "SM", fixed_off=["Saturday"]),
        make_tech("eli", "SA", fixed_off=["Monday"]),
        make_tech("fay", "SM", fixed_off=["Monday"]),
    )
    config = make_config(division_min=False)
    plan = build_plan(config, roster, empty_input(), "2026-10")
    rows = plan.by_tech()["ann"]
    for previous, following in zip(rows, rows[1:]):
        if previous.slot_id == "night":
            assert following.is_working, \
                f"night on {previous.date} runs into a day off on {following.date}"


# --------------------------------------------------------------------- xlsx

def test_xlsx_and_csv_read_the_same_way(tmp_path):
    submissions, holidays, _ = read_submissions(FIXTURE, "2026-09")
    header = ["ID 2", "Tech Name", "Choose ALL OFF days"]
    values = [["2", "ann", "September 3 Thursday"]]
    strings = header + [c for row in values for c in row]
    path = tmp_path / "form.xlsx"
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr(
            "xl/sharedStrings.xml",
            '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
            + "".join(f"<si><t>{s}</t></si>" for s in strings) + "</sst>")
        cells = lambda row, offset: "".join(
            f'<c r="{chr(65 + i)}{row}" t="s"><v>{offset + i}</v></c>' for i in range(3))
        archive.writestr(
            "xl/worksheets/sheet1.xml",
            '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
            f'<sheetData><row r="1">{cells(1, 0)}</row><row r="2">{cells(2, 3)}</row>'
            "</sheetData></worksheet>")
    assert read_rows(path)[0][:3] == header
    from_xlsx, _, _ = read_submissions(path, "2026-09")
    assert from_xlsx[0].tech == "ann"
    assert from_xlsx[0].off_days == [dt.date(2026, 9, 3)]


# ------------------------------------------------------------------- holidays
# S4 has no single public-holiday category: a holiday's day off is recorded
# under its own code, "Gandhi Jayanti(GJ)", "Vijayadasmi(VJ)". October 2026
# has both.

OCTOBER_FORM = (
    "ID,ID 2,Tech Name,Choose ALL OFF days,Unavoidable Off- 1,Unavoidable Off- 2,"
    "Holiday 1 Gandhi Jayanti October 2 Friday,Holiday 2 Vijayadashami October 21 Wednesday,"
    "\"choose LEAVE(CL, ML & PV) days only\",Any preferences and notes,Source\n"
    "a1,1,ann,October 5 Monday,,,October 2 Friday,October 20 Tuesday,,,x\n"
    "b2,2,bob,,,,October 1 Thursday,October 21 Wednesday,,,x\n"
)


def test_holiday_names_become_s4_codes():
    from s4autofill.holidays import holiday_code
    assert holiday_code("Gandhi Jayanti") == "GJ"
    assert holiday_code("Vijayadashami") == "VJ"   # S4 spells it Vijayadasmi
    assert holiday_code("Vijayadasmi") == "VJ"
    assert holiday_code("Thiruvonam") == "OM"
    assert holiday_code("Christmas Eve") == "CME"  # not Christmas
    assert holiday_code("Vishu/Good Friday") == "VGF"
    assert holiday_code("Good Friday") == "GF"
    assert holiday_code("GJ") == "GJ"
    assert holiday_code("Founders Day") is None


def test_a_day_picked_in_a_holiday_column_carries_that_holidays_code(tmp_path):
    path = tmp_path / "october.csv"
    path.write_text(OCTOBER_FORM)
    submissions, holidays, warnings = read_submissions(path, "2026-10")
    assert holidays == {"2026-10-02": "Gandhi Jayanti", "2026-10-21": "Vijayadashami"}
    assert not warnings
    roster, config = default_team(), make_config()
    month_input, _ = to_month_input(submissions, roster, config, "2026-10", holidays)
    # A day taken in lieu keeps the code of the holiday it is for.
    assert month_input.leave["ann"]["2026-10-02"] == "GJ"
    assert month_input.leave["ann"]["2026-10-20"] == "VJ"
    assert month_input.leave["bob"]["2026-10-01"] == "GJ"
    assert month_input.leave["bob"]["2026-10-21"] == "VJ"


def test_holiday_days_are_planned_as_days_off_under_their_code(tmp_path):
    path = tmp_path / "october.csv"
    path.write_text(OCTOBER_FORM)
    submissions, holidays, _ = read_submissions(path, "2026-10")
    roster, config = default_team(), make_config()
    month_input, _ = to_month_input(submissions, roster, config, "2026-10", holidays)
    rows = {r.date.isoformat(): r for r in build_plan(config, roster, month_input,
                                                      "2026-10").by_tech()["ann"]}
    assert rows["2026-10-02"].category == "GJ" and not rows["2026-10-02"].is_working
    assert rows["2026-10-20"].category == "VJ" and not rows["2026-10-20"].is_working


def test_an_unknown_holiday_is_warned_and_kept_as_ph(tmp_path):
    path = tmp_path / "odd.csv"
    path.write_text(OCTOBER_FORM.replace("Vijayadashami", "Founders Day"))
    submissions, holidays, warnings = read_submissions(path, "2026-10")
    assert any("Founders Day" in w for w in warnings)
    month_input, _ = to_month_input(submissions, default_team(), make_config(), "2026-10",
                                    holidays)
    assert month_input.leave["bob"]["2026-10-21"] == "PH"
