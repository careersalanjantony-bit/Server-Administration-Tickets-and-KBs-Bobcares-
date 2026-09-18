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
    assert set(written) == {"schedule", "grid", "summary", "preview", "payloads"}
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
