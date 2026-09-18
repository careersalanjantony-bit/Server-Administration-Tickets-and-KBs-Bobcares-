import pytest
from s4autofill.s4client import FormScraper, S4Client, suggest_mapping

PAGE = """
<html><body>
<form name="shift" action="index.php?action=view_shift" method="POST">
  <input type="hidden" name="staff_id" value="12">
  <input type="text" name="sdate" value="01-Oct-2026">
  <input type="text" name="edate" value="01-Oct-2026">
  <select name="category"><option value="W">Working Day(W)</option>
    <option value="CL">Casual Leave</option></select>
  <select name="shift_time"><option value="99">Flexy</option>
    <option value="3">06:58am-02:58pm</option></select>
  <input name="time_hh"><input name="time_mm"><input name="ampm">
  <input name="dur_h"><input name="dur_m">
  <textarea name="reason"></textarea>
</form></body></html>
"""

MAPPED = {
    "base_url": "https://s4.example.invalid",
    "post_path": "/index.php?action=view_shift",
    "login_path": "/index.php?action=login",
    "login_fields": {"username": "u", "password": "p"},
    "fields": {
        "staff": "staff_id", "category": "category", "start_date": "sdate",
        "end_date": "edate", "shift_time": "shift_time", "time_hour": "time_hh",
        "time_minute": "time_mm", "time_meridiem": "ampm", "duration_hours": "dur_h",
        "duration_minutes": "dur_m", "reason": "reason", "log": "reason",
    },
    "category_values": {"W": "W"},
    "shift_time_values": {"m0658": "3", "flexy": "99"},
    "staff_values": {"ann": "12"},
    "constant_fields": {"action": "save_shift"},
    "request_delay_seconds": 0,
}

PAYLOAD = {
    "tech_id": "ann", "tech_email": "ann@example.com", "team_id": 6, "category": "W",
    "slot_id": "m0658", "shift_time": "06:58am-02:58pm", "start_date": "01-Oct-2026",
    "end_date": "05-Oct-2026", "time": "06:58", "duration_min": 480,
    "reason": "Monthly roster autofill",
}


def test_scraper_finds_inputs_selects_and_textareas():
    parser = FormScraper()
    parser.feed(PAGE)
    parser.close()
    form = parser.forms[0]
    names = {i["name"] for i in form["inputs"]}
    assert {"staff_id", "sdate", "edate", "reason"} <= names
    assert {s["name"] for s in form["selects"]} == {"category", "shift_time"}


def test_scraper_keeps_option_values_and_labels():
    parser = FormScraper()
    parser.feed(PAGE)
    parser.close()
    options = suggest_mapping(parser.forms)["select_options"]["shift_time"]
    assert options == {"Flexy": "99", "06:58am-02:58pm": "3"}


def test_suggest_mapping_names_the_obvious_fields():
    parser = FormScraper()
    parser.feed(PAGE)
    parser.close()
    fields = suggest_mapping(parser.forms)["fields"]
    assert fields["start_date"] == "sdate"
    assert fields["end_date"] == "edate"
    assert fields["shift_time"] == "shift_time"


def test_unmapped_config_reports_every_placeholder():
    config = {**MAPPED, "fields": {**MAPPED["fields"], "staff": "TODO_staff_field"}}
    assert S4Client(config).missing_mapping() == ["staff"]


def test_push_refuses_to_execute_with_placeholders():
    config = {**MAPPED, "fields": {**MAPPED["fields"], "staff": "TODO_staff_field"}}
    client = S4Client(config, dry_run=False)
    with pytest.raises(RuntimeError, match="refusing to push"):
        client.push([PAYLOAD])


def test_dry_run_never_touches_the_network(monkeypatch):
    client = S4Client(MAPPED, dry_run=True)

    def explode(*_args, **_kwargs):
        raise AssertionError("a dry run must not open a connection")

    monkeypatch.setattr(client, "post", explode)
    monkeypatch.setattr(client, "get", explode)
    results = client.push([PAYLOAD])
    assert len(results) == 1 and results[0].ok
    assert "DRY-RUN" in results[0].detail


def test_body_maps_slot_and_staff_to_s4_values():
    body = S4Client(MAPPED).build_body(PAYLOAD)
    assert body["staff_id"] == "12"
    assert body["shift_time"] == "3"
    assert body["sdate"] == "01-Oct-2026"
    assert body["edate"] == "05-Oct-2026"
    assert body["action"] == "save_shift"       # constant_fields merged in


def test_body_splits_the_clock_into_s4_widgets():
    body = S4Client(MAPPED).build_body(PAYLOAD)
    assert (body["time_hh"], body["time_mm"], body["ampm"]) == ("6", "58", "am")
    assert (body["dur_h"], body["dur_m"]) == ("8", "00")


def test_afternoon_start_becomes_pm():
    body = S4Client(MAPPED).build_body({**PAYLOAD, "time": "14:58"})
    assert (body["time_hh"], body["ampm"]) == ("2", "pm")


def test_midnight_and_noon_are_not_reported_as_zero():
    assert S4Client(MAPPED).build_body({**PAYLOAD, "time": "00:30"})["time_hh"] == "12"
    assert S4Client(MAPPED).build_body({**PAYLOAD, "time": "12:30"})["time_hh"] == "12"


def test_push_requires_credentials_from_the_environment(monkeypatch):
    monkeypatch.delenv("S4_USER", raising=False)
    monkeypatch.delenv("S4_PASSWORD", raising=False)
    with pytest.raises(RuntimeError, match="S4_USER"):
        S4Client(MAPPED, dry_run=False).login()
