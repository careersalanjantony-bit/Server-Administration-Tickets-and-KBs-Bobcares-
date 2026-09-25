"""Which of S4's holiday categories a public holiday belongs to.

S4 does not have one "public holiday" category. A day off for a holiday is
recorded under that holiday's own code — "Gandhi Jayanti(GJ)",
"Vijayadasmi(VJ)" — and the grid shows the code. So a holiday day in the plan
has to carry the right code, worked out from the holiday's name as the form
or the --holiday flag gives it.
"""
from __future__ import annotations

import difflib
import re

# S4's own holiday categories, read off the change_shift editor's dropdown.
S4_HOLIDAYS: dict[str, str] = {
    "BR": "Bakrid",
    "CM": "Christmas",
    "CME": "Christmas Eve",
    "DV": "Deepavali",
    "ES": "Easter",
    "EUF": "Eid Ul Fither",
    "GJ": "Gandhi Jayanti",
    "GF": "Good Friday",
    "ID": "Independence Day",
    "MD": "May Day",
    "MU": "Muharram",
    "NY": "New Year",
    "OM": "Onam",
    "RD": "Republic Day",
    "SR": "Sivarathri",
    "VJ": "Vijayadasmi",
    "VS": "Vishu",
    "VGF": "Vishu/Good Friday",
}

# Other spellings people write for the same days.
ALIASES: dict[str, str] = {
    "vijayadashami": "VJ",
    "vijayadasami": "VJ",
    "dussehra": "VJ",
    "dasara": "VJ",
    "thiruvonam": "OM",
    "diwali": "DV",
    "deepawali": "DV",
    "shivaratri": "SR",
    "sivaratri": "SR",
    "eidulfitr": "EUF",
    "ramzan": "EUF",
    "ramadan": "EUF",
    "bakreid": "BR",
    "eidaladha": "BR",
    "gandhijayanthi": "GJ",
    "labourday": "MD",
    "newyearsday": "NY",
}


def _clean(text: str) -> str:
    return re.sub(r"[^a-z]", "", (text or "").lower())


def _keys() -> list[tuple[str, str]]:
    keys = [(_clean(name), code) for code, name in S4_HOLIDAYS.items()]
    keys += list(ALIASES.items())
    # Longest first, so "Christmas Eve" is not read as "Christmas" and
    # "Vishu/Good Friday" not as either half.
    return sorted(keys, key=lambda pair: -len(pair[0]))


def holiday_code(name: str) -> str | None:
    """'Gandhi Jayanti' -> 'GJ'; 'Vijayadashami' -> 'VJ'; unknown -> None.

    A bare code ("GJ") is accepted as itself. The name may carry other words
    around it — the form's column headers add the date and weekday.
    """
    raw = (name or "").strip()
    if raw.upper() in S4_HOLIDAYS:
        return raw.upper()
    text = _clean(raw)
    if not text:
        return None
    keys = _keys()
    for key, code in keys:
        if key and key in text:
            return code
    close = difflib.get_close_matches(text, [key for key, _ in keys], n=1, cutoff=0.8)
    if close:
        return dict(keys)[close[0]]
    return None


__all__ = ["S4_HOLIDAYS", "ALIASES", "holiday_code"]
