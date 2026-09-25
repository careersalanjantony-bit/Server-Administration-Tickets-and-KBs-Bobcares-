"""Read an .xlsx into rows of strings, using only the standard library.

An xlsx is a zip of XML. We need the first worksheet's cell values and the
shared-string table it points at — nothing else, so this stays small rather
than pulling in a dependency the team would have to install.
"""

from __future__ import annotations

import re
import zipfile
from pathlib import Path
from xml.etree import ElementTree

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
CELL_REF = re.compile(r"([A-Z]+)(\d+)")


def _column_index(ref: str) -> int:
    """'A' -> 0, 'B' -> 1, ... 'AA' -> 26."""
    match = CELL_REF.match(ref)
    letters = match.group(1) if match else ref
    index = 0
    for char in letters:
        index = index * 26 + (ord(char) - ord("A") + 1)
    return index - 1


def _text(element: ElementTree.Element | None) -> str:
    return "".join(element.itertext()).strip() if element is not None else ""


def _shared_strings(archive: zipfile.ZipFile) -> list[str]:
    try:
        raw = archive.read("xl/sharedStrings.xml")
    except KeyError:
        return []
    root = ElementTree.fromstring(raw)
    return [_text(si) for si in root.findall(f"{NS}si")]


def _first_sheet(archive: zipfile.ZipFile) -> str:
    names = [n for n in archive.namelist() if n.startswith("xl/worksheets/sheet")]
    if not names:
        raise ValueError("no worksheet found in the workbook")
    return sorted(names)[0]


def read_rows(path: Path | str) -> list[list[str]]:
    """Every row of the first worksheet, padded so columns line up."""
    with zipfile.ZipFile(path) as archive:
        strings = _shared_strings(archive)
        root = ElementTree.fromstring(archive.read(_first_sheet(archive)))

    rows: list[list[str]] = []
    for row in root.iter(f"{NS}row"):
        cells: dict[int, str] = {}
        for cell in row.findall(f"{NS}c"):
            index = _column_index(cell.get("r", ""))
            kind = cell.get("t", "n")
            if kind == "inlineStr":
                value = _text(cell.find(f"{NS}is"))
            else:
                value = _text(cell.find(f"{NS}v"))
                if kind == "s" and value.isdigit():
                    position = int(value)
                    value = strings[position] if position < len(strings) else ""
            if value:
                cells[index] = value
        if cells:
            width = max(cells) + 1
            rows.append([cells.get(i, "") for i in range(width)])

    width = max((len(r) for r in rows), default=0)
    return [r + [""] * (width - len(r)) for r in rows]


__all__ = ["read_rows"]
