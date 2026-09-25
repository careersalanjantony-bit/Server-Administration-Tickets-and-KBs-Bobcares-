"""Calendar helpers: month ranges, weekday names, shift clock arithmetic."""

from __future__ import annotations

import calendar
import datetime as dt
from typing import Iterator

WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
_WEEKDAY_INDEX = {name.lower(): i for i, name in enumerate(WEEKDAYS)}
_WEEKDAY_INDEX.update({name[:3].lower(): i for i, name in enumerate(WEEKDAYS)})


def parse_month(value: str) -> tuple[int, int]:
    """Parse 'YYYY-MM' into (year, month)."""
    try:
        year_s, month_s = value.split("-")
        year, month = int(year_s), int(month_s)
    except ValueError as exc:
        raise ValueError(f"month must look like YYYY-MM, got {value!r}") from exc
    if not 1 <= month <= 12:
        raise ValueError(f"month out of range in {value!r}")
    return year, month


def month_days(year: int, month: int) -> list[dt.date]:
    last = calendar.monthrange(year, month)[1]
    return [dt.date(year, month, day) for day in range(1, last + 1)]


def month_bounds(year: int, month: int) -> tuple[dt.date, dt.date]:
    days = month_days(year, month)
    return days[0], days[-1]


def weekday_name(day: dt.date) -> str:
    return WEEKDAYS[day.weekday()]


def weekday_index(name: str) -> int:
    """Accept 'Sunday', 'sun', 'SUNDAY'. Raises ValueError on anything else."""
    key = name.strip().lower()
    if key not in _WEEKDAY_INDEX:
        raise ValueError(f"unknown weekday {name!r}")
    return _WEEKDAY_INDEX[key]


def normalise_weekdays(names: list[str]) -> list[str]:
    """Canonicalise a fixed-off list, de-duplicated and in week order."""
    idx = sorted({weekday_index(n) for n in names})
    return [WEEKDAYS[i] for i in idx]


def parse_hhmm(value: str) -> dt.time:
    hour, minute = value.split(":")
    return dt.time(int(hour), int(minute))


def shift_window(day: dt.date, start: str, duration_min: int) -> tuple[dt.datetime, dt.datetime]:
    """Absolute start/end of a shift, so overnight shifts compare correctly."""
    begin = dt.datetime.combine(day, parse_hhmm(start))
    return begin, begin + dt.timedelta(minutes=duration_min)


def iter_dates(start: dt.date, end: dt.date) -> Iterator[dt.date]:
    cur = start
    while cur <= end:
        yield cur
        cur += dt.timedelta(days=1)


def s4_date(day: dt.date) -> str:
    """S4's date format, e.g. 01-Oct-2026."""
    return f"{day.day:02d}-{calendar.month_abbr[day.month]}-{day.year}"
