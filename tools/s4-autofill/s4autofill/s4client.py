"""Talking to S4.

S4 is a plain PHP form app, so this is a cookie session plus form posts. The
field names are not hard-coded: `inspect` reads them off the real page and
writes them into config/s4_form.json, because guessing them would silently
write the wrong thing into a live roster.

Nothing here runs against S4 unless you pass --execute. Dry runs print exactly
what would be posted.
"""

from __future__ import annotations

import http.cookiejar
import json
import os
import re
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from html.parser import HTMLParser
from pathlib import Path
from typing import Any

from .model import CONFIG_DIR

USER_AGENT = "s4autofill/1.0 (+internal roster tool)"
PLACEHOLDER = "TODO_"


class FormScraper(HTMLParser):
    """Pull form/input/select names out of an S4 page."""

    def __init__(self) -> None:
        super().__init__()
        self.forms: list[dict[str, Any]] = []
        self._form: dict[str, Any] | None = None
        self._select: dict[str, Any] | None = None
        self._option: dict[str, Any] | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        a = {k: (v or "") for k, v in attrs}
        if tag == "form":
            self._form = {"name": a.get("name", ""), "action": a.get("action", ""),
                          "method": a.get("method", "GET").upper(), "inputs": [], "selects": []}
        elif tag == "input" and self._form is not None:
            self._form["inputs"].append(
                {"name": a.get("name", ""), "type": a.get("type", "text"), "value": a.get("value", "")}
            )
        elif tag == "textarea" and self._form is not None:
            self._form["inputs"].append(
                {"name": a.get("name", ""), "type": "textarea", "value": ""}
            )
        elif tag == "select" and self._form is not None:
            self._select = {"name": a.get("name", ""), "options": []}
        elif tag == "option" and self._select is not None:
            self._option = {"value": a.get("value", ""), "text": ""}

    def handle_data(self, data: str) -> None:
        if self._option is not None:
            self._option["text"] += data.strip()

    def handle_endtag(self, tag: str) -> None:
        if tag == "option" and self._option is not None and self._select is not None:
            self._option["value"] = self._option["value"] or self._option["text"]
            self._select["options"].append(self._option)
            self._option = None
        elif tag == "select" and self._select is not None and self._form is not None:
            self._form["selects"].append(self._select)
            self._select = None
        elif tag == "form" and self._form is not None:
            self.forms.append(self._form)
            self._form = None

    def close(self) -> None:  # tolerate S4's unclosed <form> tags
        super().close()
        if self._form is not None:
            self.forms.append(self._form)
            self._form = None


@dataclass
class PushResult:
    payload: dict[str, Any]
    ok: bool
    detail: str = ""


@dataclass
class S4Client:
    form_config: dict[str, Any]
    dry_run: bool = True
    timeout: int = 30
    _opener: Any = field(default=None, repr=False)

    # ------------------------------------------------------------- plumbing

    def __post_init__(self) -> None:
        jar = http.cookiejar.CookieJar()
        context = ssl.create_default_context()
        if not self.form_config.get("verify_tls", True):
            context.check_hostname = False
            context.verify_mode = ssl.CERT_NONE
        self._opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(jar),
            urllib.request.HTTPSHandler(context=context),
        )
        self._opener.addheaders = [("User-Agent", USER_AGENT)]

    def _url(self, path: str, **params: Any) -> str:
        return self.form_config["base_url"].rstrip("/") + path.format(**params)

    def get(self, url: str) -> str:
        with self._opener.open(url, timeout=self.timeout) as response:
            return response.read().decode("utf-8", "replace")

    def post(self, url: str, data: dict[str, str]) -> str:
        body = urllib.parse.urlencode(data).encode()
        request = urllib.request.Request(url, data=body, method="POST")
        with self._opener.open(request, timeout=self.timeout) as response:
            return response.read().decode("utf-8", "replace")

    # ---------------------------------------------------------------- login

    def login(self) -> None:
        user, password = os.environ.get("S4_USER"), os.environ.get("S4_PASSWORD")
        if not user or not password:
            raise RuntimeError(
                "set S4_USER and S4_PASSWORD in the environment before pushing "
                "(they are deliberately not read from any config file)"
            )
        fields = self.form_config["login_fields"]
        self.post(self._url(self.form_config["login_path"]),
                  {fields["username"]: user, fields["password"]: password})

    # -------------------------------------------------------------- inspect

    def inspect(self, url: str) -> list[dict[str, Any]]:
        parser = FormScraper()
        parser.feed(self.get(url))
        parser.close()
        return parser.forms

    # ----------------------------------------------------------------- push

    def missing_mapping(self) -> list[str]:
        """Field mappings still holding their placeholder value."""
        return sorted(
            key for key, value in self.form_config.get("fields", {}).items()
            if isinstance(value, str) and value.startswith(PLACEHOLDER)
        )

    def build_body(self, payload: dict[str, Any]) -> dict[str, str]:
        """Turn one planned batch into the POST body S4 expects."""
        fields = self.form_config["fields"]
        categories = self.form_config.get("category_values", {})
        shifts = self.form_config.get("shift_time_values", {})
        staff = self.form_config.get("staff_values", {})

        hour, minute = payload["time"].split(":")
        hour_i = int(hour)
        meridiem = "am" if hour_i < 12 else "pm"
        display_hour = hour_i % 12 or 12
        duration_h, duration_m = divmod(int(payload["duration_min"]), 60)

        body = {
            fields["staff"]: staff.get(payload["tech_id"], payload["tech_id"]),
            fields["category"]: categories.get(payload["category"], payload["category"]),
            fields["start_date"]: payload["start_date"],
            fields["end_date"]: payload["end_date"],
            fields["shift_time"]: shifts.get(payload["slot_id"] or "", payload["shift_time"]),
            fields["time_hour"]: str(display_hour),
            fields["time_minute"]: minute,
            fields["time_meridiem"]: meridiem,
            fields["duration_hours"]: str(duration_h),
            fields["duration_minutes"]: f"{duration_m:02d}",
            fields["reason"]: payload["reason"],
            fields["log"]: payload["reason"],
        }
        body.update(self.form_config.get("constant_fields", {}))
        return body

    def push(self, payloads: list[dict[str, Any]], limit: int | None = None) -> list[PushResult]:
        results: list[PushResult] = []
        if not self.dry_run:
            missing = self.missing_mapping()
            if missing:
                raise RuntimeError(
                    "refusing to push: these form fields are still placeholders in "
                    f"config/s4_form.json: {', '.join(missing)}. Run "
                    "`s4autofill inspect --url <shift edit page> --save` first."
                )
            # S4 changes a shift by its calendar row, and cal_id is per person
            # per day. It only comes from the month grid's popup() calls, which
            # this client does not read, so every body it built would name no
            # row at all. The extension reads the grid and opens each row's
            # editor; until this does the same, it must not write.
            raise RuntimeError(
                "refusing to push: S4 needs each block's own calendar row (cal_id), which "
                "only the Firefox extension reads from the month grid. Use the extension "
                "to fill S4; this command's dry run still shows what the plan holds."
            )
        url = self._url(self.form_config["post_path"])
        delay = float(self.form_config.get("request_delay_seconds", 0.5))
        for payload in payloads[:limit] if limit else payloads:
            body = self.build_body(payload)
            if self.dry_run:
                results.append(PushResult(payload, True, f"DRY-RUN POST {url} {body}"))
                continue
            try:
                response = self.post(url, body)
                ok = "error" not in response.lower()[:4000]
                results.append(PushResult(payload, ok, "posted" if ok else "S4 returned an error page"))
            except urllib.error.URLError as exc:
                results.append(PushResult(payload, False, f"{type(exc).__name__}: {exc}"))
            time.sleep(delay)
        return results


def load_form_config(path: Path | None = None) -> dict[str, Any]:
    with open(path or CONFIG_DIR / "s4_form.json") as f:
        return json.load(f)


def save_form_config(config: dict[str, Any], path: Path | None = None) -> Path:
    target = Path(path or CONFIG_DIR / "s4_form.json")
    with open(target, "w") as f:
        json.dump(config, f, indent=2)
        f.write("\n")
    return target


TIME = re.compile(r"(\d{1,2}):(\d{2})\s*([ap]m)", re.I)


def _time_key(text: str) -> str:
    """Canonical key for a shift label, so '7:00am-3:00pm' and
    '07:00am-03:00pm' are recognised as the same slot."""
    parts = [f"{int(h)}:{m}{ap.lower()}" for h, m, ap in TIME.findall(text or "")]
    return "-".join(parts)


def _clean(text: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (text or "").lower())


def match_options(forms: list[dict[str, Any]], config: Any, roster: Any = None) -> dict[str, Any]:
    """Work out which dropdown option means which slot, category and tech.

    The slot labels in shifts.json were transcribed from S4's own column
    headers, so they match its dropdown text directly — which means this
    mapping does not have to be typed out by hand.
    """
    slots_by_time = {_time_key(s.label): s.id for s in config.slots if _time_key(s.label)}
    slots_by_name = {_clean(s.label): s.id for s in config.slots}
    categories = {_clean(name): code for code, name in config.categories.items()}
    techs: dict[str, str] = {}
    if roster is not None:
        for tech in roster.techs:
            for alias in (tech.id, tech.display_name, tech.email.split("@")[0]):
                techs[_clean(alias)] = tech.id

    shift_time_values: dict[str, str] = {}
    category_values: dict[str, str] = {}
    staff_values: dict[str, str] = {}
    unmatched: dict[str, list[str]] = {}
    fields: dict[str, str] = {}

    for form in forms:
        for select in form.get("selects", []):
            options = [o for o in select.get("options", []) if (o.get("text") or "").strip()]
            if not options:
                continue
            slots, cats, staff, missed = {}, {}, {}, []
            for option in options:
                text, value = option["text"].strip(), option.get("value", "")
                slot_id = slots_by_time.get(_time_key(text)) or slots_by_name.get(_clean(text))
                code = categories.get(_clean(text))
                if not code:
                    # S4 writes categories as 'Working Day(W)'.
                    inner = re.search(r"\(([A-Z]{1,3})\)", text)
                    if inner and inner.group(1) in config.categories:
                        code = inner.group(1)
                tech_id = techs.get(_clean(text))
                if slot_id:
                    slots[slot_id] = value
                elif code:
                    cats[code] = value
                elif tech_id:
                    staff[tech_id] = value
                else:
                    missed.append(text)

            best = max(len(slots), len(cats), len(staff))
            if best == 0:
                unmatched[select["name"]] = missed[:12]
                continue
            if len(slots) == best:
                shift_time_values.update(slots)
                fields["shift_time"] = select["name"]
            elif len(cats) == best:
                category_values.update(cats)
                fields["category"] = select["name"]
            else:
                staff_values.update(staff)
                fields["staff"] = select["name"]
            if missed:
                unmatched[select["name"]] = missed[:12]

    return {
        "fields": fields,
        "shift_time_values": shift_time_values,
        "category_values": category_values,
        "staff_values": staff_values,
        "unmatched": unmatched,
    }


def suggest_mapping(forms: list[dict[str, Any]], form_name: str = "shift") -> dict[str, Any]:
    """Best-effort guess at the field mapping from a scraped page.

    Only obvious matches are filled in; anything ambiguous is left alone so a
    human still has to look at it.
    """
    hints = {
        "staff": ("staff", "user", "emp", "tech"),
        "category": ("category", "cat", "type"),
        "start_date": ("sdate", "start"),
        "end_date": ("edate", "end"),
        "shift_time": ("shift_time", "shifttime", "shift"),
        "time_hour": ("hour", "hh", "_h"),
        "time_minute": ("min", "mm", "_m"),
        "time_meridiem": ("ampm", "meridiem", "am_pm"),
        "duration_hours": ("dur_h", "durationh", "duration_hour"),
        "duration_minutes": ("dur_m", "durationm", "duration_min"),
        "reason": ("reason",),
        "log": ("log", "comment"),
    }
    target = next((f for f in forms if f["name"] == form_name), None) or (forms[0] if forms else None)
    if target is None:
        return {"fields": {}, "shift_time_values": {}, "category_values": {}}

    names = [i["name"] for i in target["inputs"] if i["name"]]
    names += [s["name"] for s in target["selects"] if s["name"]]
    fields: dict[str, str] = {}
    for key, needles in hints.items():
        for name in names:
            if any(needle in name.lower() for needle in needles):
                fields[key] = name
                break

    options: dict[str, dict[str, str]] = {}
    for select in target["selects"]:
        options[select["name"]] = {o["text"]: o["value"] for o in select["options"] if o["text"]}
    return {"fields": fields, "select_options": options}


__all__ = ["S4Client", "FormScraper", "PushResult", "load_form_config", "save_form_config",
           "suggest_mapping", "match_options"]
