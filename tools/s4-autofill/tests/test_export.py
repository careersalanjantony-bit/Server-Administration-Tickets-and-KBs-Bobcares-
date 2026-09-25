import csv
import datetime as dt
import json

from helpers import default_team, empty_input, make_config
from s4autofill.export import batch_assignments, write_all, write_grid_csv, write_payloads
from s4autofill.scheduler import build_plan


def build(tmp_path):
    config, roster = make_config(), default_team()
    plan = build_plan(config, roster, empty_input(), "2026-10")
    return plan, config, roster


def test_write_all_produces_every_artefact(tmp_path):
    plan, config, roster = build(tmp_path)
    written = write_all(plan, config, roster, tmp_path)
    assert set(written) == {"schedule", "grid", "summary", "preview", "payloads", "extension"}
    for path in written.values():
        assert path.exists() and path.stat().st_size > 0


def test_grid_has_one_row_per_day_and_a_column_per_slot(tmp_path):
    plan, config, roster = build(tmp_path)
    path = write_grid_csv(plan, config, roster, tmp_path / "grid.csv")
    rows = list(csv.reader(open(path)))
    assert len(rows) == 1 + len(plan.days)
    assert rows[0] == ["Date"] + [s.label for s in config.slots] + ["Leaves/Offs"]


def test_days_off_show_in_the_leaves_column(tmp_path):
    plan, config, roster = build(tmp_path)
    path = write_grid_csv(plan, config, roster, tmp_path / "grid.csv")
    rows = list(csv.reader(open(path)))
    sunday = next(r for r, day in zip(rows[1:], plan.days) if day.weekday() == 6)
    assert "ann OFF" in sunday[-1]


def test_batches_collapse_consecutive_identical_days(tmp_path):
    plan, config, roster = build(tmp_path)
    batches = batch_assignments(plan)
    assert len(batches) < len(plan.assignments)
    for batch in batches:
        assert batch.days >= 1
        assert batch.start <= batch.end


def test_batches_cover_every_tech_day_exactly_once(tmp_path):
    plan, config, roster = build(tmp_path)
    covered = 0
    for batch in batch_assignments(plan):
        covered += batch.days
    assert covered == len(plan.assignments)


def test_batches_never_merge_across_a_slot_change(tmp_path):
    plan, config, roster = build(tmp_path)
    per_tech = plan.by_tech()
    for batch in batch_assignments(plan):
        rows = {r.date: r for r in per_tech[batch.tech_id]}
        day = batch.start
        while day <= batch.end:
            assert (rows[day].slot_id or "") == batch.slot_id
            assert rows[day].category == batch.category
            day += dt.timedelta(days=1)


def test_payloads_carry_s4_formatted_dates(tmp_path):
    plan, config, roster = build(tmp_path)
    path = write_payloads(plan, config, roster, tmp_path / "payloads.jsonl")
    rows = [json.loads(line) for line in path.read_text().splitlines()]
    assert rows
    for row in rows:
        assert row["start_date"].endswith("-Oct-2026")
        assert row["duration_min"] == 480
        assert row["team_id"] == 1


def test_extension_plan_carries_what_the_browser_needs(tmp_path):
    """The extension works the mapping out from the plan, so the plan has to
    carry the slot labels, the categories and the roster."""
    import json
    from s4autofill.export import write_extension_plan
    plan, config, roster = build(tmp_path)
    path = write_extension_plan(plan, config, roster, tmp_path / "plan.json")
    doc = json.loads(path.read_text())
    assert doc["month"] == "2026-10"
    assert {s["id"] for s in doc["slots"]} == {s.id for s in config.slots}
    assert all(s["label"] for s in doc["slots"])
    assert doc["categories"]["W"]
    assert {t["id"] for t in doc["techs"]} == {t.id for t in roster.techs if t.active}
    assert doc["assignments"]


def test_extension_plan_covers_every_tech_day(tmp_path):
    import json
    from s4autofill.export import write_extension_plan
    plan, config, roster = build(tmp_path)
    doc = json.loads(write_extension_plan(plan, config, roster, tmp_path / "p.json").read_text())
    assert sum(a["days"] for a in doc["assignments"]) == len(plan.assignments)


def test_extension_plan_says_why_each_shift_was_chosen(tmp_path):
    """The popup shows this per row, so the preference reasoning stays visible."""
    import json
    from s4autofill.export import write_extension_plan
    plan, config, roster = build(tmp_path)
    doc = json.loads(write_extension_plan(plan, config, roster, tmp_path / "p.json").read_text())
    assert any(a["source"] for a in doc["assignments"])


def test_holiday_codes_reach_the_extension_plan_and_fold_into_ph_in_the_summary(tmp_path):
    from s4autofill.model import MonthInput
    config, roster = make_config(), default_team()
    month_input = MonthInput(
        month="2026-10",
        public_holidays={"2026-10-02": "Gandhi Jayanti"},
        leave={"ann": {"2026-10-02": "PH"}},
    )
    plan = build_plan(config, roster, month_input, "2026-10")
    written = write_all(plan, config, roster, tmp_path)
    extension = json.loads(written["extension"].read_text())
    assert extension["categories"]["GJ"] == "Gandhi Jayanti"
    assert any(a["tech_id"] == "ann" and a["category"] == "GJ" and a["start_date"] == "02-Oct-2026"
               for a in extension["assignments"])
    rows = list(csv.reader(open(written["summary"])))
    header = rows[0]
    assert "GJ" not in header, "eighteen holiday columns would bury the sheet"
    ann = next(r for r in rows[1:] if r[1] == roster.get("ann").display_name)
    assert ann[header.index("PH")] == "1"
