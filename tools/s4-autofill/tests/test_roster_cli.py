import json

import pytest
from helpers import default_team, make_config, write_shifts_file
from s4autofill.cli import main
from s4autofill.model import load_roster, save_roster


@pytest.fixture()
def roster_file(tmp_path):
    path = tmp_path / "roster.json"
    save_roster(default_team(), path)
    return path


@pytest.fixture()
def shifts_file(tmp_path):
    return write_shifts_file(tmp_path / "shifts.json")


def read(path):
    return json.loads(path.read_text())


def ids(path):
    return [t["id"] for t in read(path)["techs"]]


def test_add_a_joiner(roster_file, shifts_file, capsys):
    code = main(["--roster", str(roster_file), "--shifts", str(shifts_file), "roster", "add", "zoe",
                 "--division", "SM", "--fixed-off", "Friday", "Saturday",
                 "--joined", "2026-11-03"])
    assert code == 0
    zoe = load_roster(roster_file).get("zoe")
    assert zoe.division == "SM"
    assert zoe.fixed_off == ["Friday", "Saturday"]
    assert zoe.joined == "2026-11-03"
    assert zoe.email == "zoe@poornam.com"


def test_adding_a_duplicate_is_refused(roster_file, capsys):
    assert main(["--roster", str(roster_file), "roster", "add", "ann",
                 "--division", "SA"]) == 1
    assert "already in the roster" in capsys.readouterr().err


def test_adding_with_an_unknown_slot_is_refused(roster_file, capsys):
    assert main(["--roster", str(roster_file), "roster", "add", "zoe",
                 "--division", "SA", "--prefer", "graveyard"]) == 1
    assert "unknown slot" in capsys.readouterr().err


def test_remove_deactivates_by_default_and_keeps_history(roster_file):
    main(["--roster", str(roster_file), "roster", "remove", "ann", "--left", "2026-11-01"])
    roster = load_roster(roster_file)
    assert "ann" in ids(roster_file)          # row kept, so old months still resolve
    assert roster.get("ann").active is False
    assert roster.get("ann").left == "2026-11-01"


def test_hard_remove_deletes_the_row(roster_file):
    main(["--roster", str(roster_file), "roster", "remove", "ann", "--hard"])
    assert "ann" not in ids(roster_file)


def test_set_updates_preferences_and_queue_position(roster_file, shifts_file):
    main(["--roster", str(roster_file), "--shifts", str(shifts_file), "roster", "set", "ann",
          "--prefer", "night", "eve", "--submitted-at", "2026-09-20T09:00:00",
          "--flexy-start", "10:00", "--max-nights", "4"])
    ann = load_roster(roster_file).get("ann")
    assert ann.preferences == ["night", "eve"]
    assert ann.prefs_submitted_at == "2026-09-20T09:00:00"
    assert ann.flexy_start == "10:00"
    assert ann.max_nights_per_month == 4


def test_set_normalises_weekday_spelling(roster_file):
    main(["--roster", str(roster_file), "roster", "set", "ann", "--fixed-off", "sat", "SUNDAY"])
    assert load_roster(roster_file).get("ann").fixed_off == ["Saturday", "Sunday"]


def test_round_trip_through_json_keeps_every_field(roster_file, shifts_file):
    main(["--roster", str(roster_file), "--shifts", str(shifts_file), "roster", "set", "ann",
          "--prefer", "night", "--avoid", "morn", "--note", "prefers nights"])
    first = load_roster(roster_file)
    save_roster(first, roster_file)
    second = load_roster(roster_file)
    assert first.get("ann").to_dict() == second.get("ann").to_dict()


def test_list_runs_and_reports_the_active_count(roster_file, capsys):
    assert main(["--roster", str(roster_file), "roster", "list"]) == 0
    assert "6 active of 6" in capsys.readouterr().out
