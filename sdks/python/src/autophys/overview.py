"""Project overviews: the checks every overview write shares (OV-3, OV-4).

An overview is one Markdown research note per project, kept as an
append-only history in workbook format 3 (``WorkbookStore.put_overview``).
A write is refused only for an empty or whitespace-only body, more than
:data:`MAX_OVERVIEW_BYTES` of UTF-8, invalid UTF-8 or a missing author.
Everything else is advisory: :func:`check_overview` returns warnings.

The warnings come from a canonical-form lint (OV-13), not from a Markdown
parser. An insert is accepted silently only when it is written alone on one
line at column 0, after a blank line or at the start of the document, as
``<ap-investigation …></ap-investigation>``, outside fenced and indented code.
Every other line that mentions the insert tag outside code, and every line
that may start an HTML block, gets a warning. The lint over-warns on purpose:
a document with no warnings renders one card per canonical insert line, and
no insert hides text. Text the viewer drops for reasons unrelated to inserts
(inline HTML, a hard break in a setext heading, nesting past markdown-it's
limit) is not checked. ``html/routes/overview-vectors.deno.test.ts`` holds that against
the bundled viewer. Canonical inserts are also checked for investigations the
workbook does not hold and attribute keys the viewer does not know. The tags
and keys come from ``investigation-inserts.json``, a byte-for-byte copy of
``html/ui/investigation-inserts.json``. The rules mirror
``sdks/rust/src/workbook/overview.rs``; ``tests/conformance/overview/cases.json``
pins both.
"""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Any, Callable, Iterable

from ._text import rust_trim

#: Largest overview body, in UTF-8 bytes (256 KiB).
MAX_OVERVIEW_BYTES = 256 * 1024
MAX_AUTHOR_CHARS = 200

INSERTS_JSON = Path(__file__).with_name("investigation-inserts.json")
_SPACE = " \t\n\r\x0c"
_UNAVAILABLE = 'the viewer shows "Investigation unavailable"'


def _lower(text: str) -> str:
    """ASCII-only lowercasing, as Rust's ``to_ascii_lowercase``."""
    return "".join(chr(ord(c) + 32) if "A" <= c <= "Z" else c for c in text)


_INSERTS = [{"tag": i["tag"], "reference": i["reference"], "attributes": tuple(i["attributes"])}
            for i in json.loads(INSERTS_JSON.read_text(encoding="utf-8"))["inserts"]]


def check_write(markdown: Any, author: Any, error: Callable[[str, str, str | None], Exception]) -> str:
    """The Markdown as ``str``, or raise ``error(code, message, path)`` for
    what OV-3 refuses. ``code`` is ``invalid`` or ``too_large``."""
    if isinstance(markdown, (bytes, bytearray)):
        try:
            markdown = bytes(markdown).decode("utf-8")
        except UnicodeDecodeError:
            raise error("invalid", "must be UTF-8", "markdown") from None
    if not isinstance(markdown, str):
        raise error("invalid", "required Markdown text", "markdown")
    try:
        size = len(markdown.encode("utf-8"))
    except UnicodeEncodeError:
        raise error("invalid", "must be UTF-8", "markdown") from None
    if size > MAX_OVERVIEW_BYTES:
        raise error("too_large", f"overview exceeds {MAX_OVERVIEW_BYTES} bytes", None)
    if not rust_trim(markdown):
        raise error("invalid", "required non-empty Markdown", "markdown")
    if not isinstance(author, str) or not rust_trim(author) or len(author) > MAX_AUTHOR_CHARS:
        raise error("invalid", "required string of 1 to 200 characters", "author")
    return markdown


def digest(markdown: str) -> str:
    """Bare sha256 hex of the UTF-8 body."""
    return hashlib.sha256(markdown.encode("utf-8")).hexdigest()


def check_overview(markdown: str, known: Iterable[str]) -> list[dict]:
    """Advisory warnings for ``markdown`` in a workbook holding the
    investigations ``known``, in document order (OV-13).

    Codes: ``noncanonical_insert`` (with ``line`` and ``reason``) for a line
    that mentions an insert tag but is not a canonical insert; ``html_block``
    (with ``line``) for a line that may start an HTML block; and, for
    canonical inserts only, ``unknown_attribute`` and ``unknown_investigation``,
    each finding once. Lines inside fenced or indented code are skipped.
    """
    return lint(markdown, known)[0]


def lint(markdown: str, known: Iterable[str]) -> tuple[list[dict], list[int]]:
    """``(warnings, cards)``: :func:`check_overview`'s warnings and the 1-based
    lines of the canonical inserts. When there are no warnings, the viewer
    shows exactly one card for each of those lines and nothing else."""
    known = set(known)
    seen: set[tuple[str, str]] = set()
    out: list[dict] = []
    cards: list[int] = []
    lines = _lines(markdown)
    states = {_START}
    lost = False
    for index, line in enumerate(lines):
        number = index + 1
        readings = [] if lost else [r for state in states for r in _step(state, line)]
        if readings and all(code for _, code in readings):
            states = {state for state, _ in readings}
            continue
        open_code = lost or any(code for _, code in readings)
        lower = _lower(line)
        mention = next((s for s in _INSERTS if f"<{s['tag']}" in lower or f"</{s['tag']}" in lower), None)
        canonical = None
        if mention is not None:
            after = lines[index + 1] if index + 1 < len(lines) else ""
            prev_blank = index == 0 or _blank(lines[index - 1])
            reason, attrs = _canonical(line, lower, mention["tag"], prev_blank, _blank(after), open_code)
            if reason is None:
                canonical = attrs
                cards.append(number)
                _card_warnings(mention, attrs, known, seen, out)
            else:
                tag = mention["tag"]
                out.append({"code": "noncanonical_insert",
                            "message": f"<{tag}> on line {number} is not in canonical form ({reason}), so the viewer "
                                       f"may show no card or hide text; write each insert alone on one line at "
                                       f"column 0 after a blank line, as <{tag} ...></{tag}>",
                            "line": number, "reason": reason})
        elif _html_start(line):
            out.append({"code": "html_block",
                        "message": f"line {number} starts with an HTML tag; if the viewer reads it as an HTML block "
                                   'it shows "The document could not be displayed" instead of the overview, and an '
                                   "unclosed element can hide the lines after it",
                        "line": number})
        if lost:
            continue
        if canonical is not None:
            states = {_START}
            continue
        states = {state for state, _ in readings}
        if len(states) > _MAX_READINGS:
            lost = True
    return out, cards


def _canonical(line: str, lower: str, tag: str, prev_blank: bool, next_blank: bool,
               open_code: bool) -> tuple[str | None, list[tuple[str, str]]]:
    """``(None, attributes)`` for a canonical insert line, else ``(reason, [])``."""
    start, close = f"<{tag}", f"</{tag}>"
    if lower.count(start) > 1 or lower.count(f"</{tag}") > 1:
        return "more than one insert tag on the line", []
    if not line.startswith(start):
        if lower.startswith(start):
            return "the tag is not lowercase", []
        if start in lower:
            return "it does not start at column 0", []
        return "a closing tag without its start tag on the line", []
    if len(line) > len(start) and line[len(start)] not in " \t>":
        return f"the tag name continues past {tag}", []
    parsed = _start_tag(line, 1)
    if parsed is None:
        return "the start tag is not closed on the line", []
    _, attrs, end = parsed
    rest = line[end:]
    if not rest.startswith(close):
        if close in rest:
            return f"text between the start tag and {close}", []
        return f"no {close} on the same line", []
    if rest[len(close):].strip(" \t"):
        return f"text after {close}", []
    if "|" in line and not next_blank:
        return "a | in the line with a non-blank next line could make it a table header", []
    if not prev_blank:
        return "it does not follow a blank line", []
    if open_code:
        return "a code block opened earlier may still be open", []
    return None, attrs


# --- where code may be open ---------------------------------------------------
# Not a Markdown parser: an over-approximation of CommonMark's fences, indented
# code and list items, enough to skip lines that are certainly code and to know
# that a canonical line is certainly not. Each reading is
# (fence, marker, run, item column, items, paragraph): fence 0 is none, 1 a
# top-level fence, 2 a fence inside the list item whose content starts at
# ``item column``; ``items`` are the open list items as (content column,
# started empty); ``paragraph`` says the previous line may be paragraph text, so
# the next one may continue it lazily. Where a line has two readings both are
# kept; a line is code only when every reading says so.
_START = (0, "", 0, 0, (), False)
_MAX_READINGS = 64
_NEWLINES = re.compile(r"\r\n?|\n")
_JS_SPACE = frozenset(" \t\x0b\x0c      　﻿"
                      + "".join(chr(c) for c in range(0x2000, 0x200B)))
_PREFIX = _JS_SPACE | frozenset(">-+*.)0123456789")
_BREAK = re.compile(r"(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})")


def _lines(markdown: str) -> list[str]:
    """The lines the viewer numbers (``\\r\\n``, ``\\r`` and ``\\n`` all end one)."""
    lines = _NEWLINES.split(markdown)
    if lines and lines[-1] == "":
        lines.pop()
    return lines


def _blank(line: str) -> bool:
    return line.strip(" \t") == ""


def _indent(line: str, i: int = 0, col: int = 0) -> tuple[int, int]:
    """``(column, index)`` after the spaces and tabs from ``line[i]`` at ``col``."""
    while i < len(line) and line[i] in " \t":
        col = col + 4 - col % 4 if line[i] == "\t" else col + 1
        i += 1
    return col, i


def _fence(rest: str) -> tuple[str, int] | None:
    """A fence opener's marker and run length."""
    if not rest or rest[0] not in "`~":
        return None
    run = len(rest) - len(rest.lstrip(rest[0]))
    if run < 3 or (rest[0] == "`" and "`" in rest[run:]):
        return None
    return rest[0], run


def _closes(rest: str, marker: str, run: int) -> bool:
    n = len(rest) - len(rest.lstrip(marker)) if rest[:1] == marker else 0
    return n >= run and rest[n:].strip(" \t") == ""


def _marker(line: str, i: int, col: int) -> tuple[int, int | None, bool] | None:
    """A list marker at ``line[i]`` (column ``col``): its item's content
    column, the index of its content (None when the item starts empty or with
    indented code) and whether the item starts empty."""
    j = i
    if line[j:j + 1] in ("-", "+", "*"):
        j += 1
    else:
        while j < len(line) and j - i < 9 and "0" <= line[j] <= "9":
            j += 1
        if j == i or line[j:j + 1] not in (".", ")"):
            return None
        j += 1
    if j < len(line) and line[j] not in " \t":
        return None
    after, k = _indent(line, j, col + j - i)
    if k == len(line):
        return col + j - i + 1, None, True
    if after - (col + j - i) > 4:
        return col + j - i + 1, None, False
    return after, k, False


def _step(state: tuple, line: str) -> list[tuple[tuple, bool]]:
    """The readings after ``line`` from one reading, each with whether the
    line is code in it."""
    fence, marker, run, column, items, paragraph = state
    col, i = _indent(line)
    if i == len(line):
        if fence:
            return [(state[:5] + (False,), True)]
        return [((0, "", 0, 0, tuple(x for x in items if not x[1]), False), False)]
    items = tuple((c, False) for c, _ in items)
    if fence == 1:
        if col < 4 and _closes(line[i:], marker, run):
            return [(_START, True)]
        return [(state, True)]
    if fence == 2:
        if col >= column:
            if col - column < 4 and _closes(line[i:], marker, run):
                return [((0, "", 0, 0, items, False), True)]
            return [((2, marker, run, column, items, False), True)]
        return _plain(tuple(x for x in items if x[0] <= col), False, line, col, i)
    return _plain(items, paragraph, line, col, i)


def _plain(items: tuple, paragraph: bool, line: str, col: int, i: int) -> list[tuple[tuple, bool]]:
    """Readings for a non-blank line outside fenced code."""
    rest = line[i:]
    inner = tuple(x for x in items if x[0] <= col)
    relative = col - (inner[-1][0] if inner else 0)
    opener = _fence(rest)
    if relative < 4 and opener is not None:
        if inner:
            return [((2, opener[0], opener[1], inner[-1][0], inner, False), False)]
        return [((1, opener[0], opener[1], 0, (), False), False)]
    if relative < 4 and rest.startswith(">"):
        return [((0, "", 0, 0, inner, True), False)]
    out: list[tuple[tuple, bool]] = []
    if paragraph and len(inner) < len(items):
        out.append(((0, "", 0, 0, items, True), False))
    if relative >= 4:
        out.append(((0, "", 0, 0, inner, paragraph), not paragraph))
        return out
    added = list(inner)
    at, at_col = i, col
    while not _BREAK.fullmatch(line[at:]):
        found = _marker(line, at, at_col)
        if found is None:
            break
        content, at, empty = found
        added.append((content, empty))
        if at is None:
            break
        at_col = content
    if len(added) == len(inner):
        out.append(((0, "", 0, 0, inner, True), False))
        return out
    if paragraph:
        out.append(((0, "", 0, 0, inner, True), False))
    opener = _fence(line[at:]) if at is not None else None
    if opener is not None:
        out.append(((2, opener[0], opener[1], added[-1][0], tuple(added), False), False))
    else:
        out.append(((0, "", 0, 0, tuple(added), True), False))
    return out


def _html_start(line: str) -> bool:
    """Whether the line, past anything that could be container markers or
    whitespace, starts with something an HTML block could start with."""
    i = 0
    while i < len(line) and line[i] in _PREFIX:
        i += 1
    rest = line[i:]
    if len(rest) < 2 or rest[0] != "<":
        return False
    if rest[1] in "!?/":
        return True
    if not ("a" <= rest[1] <= "z" or "A" <= rest[1] <= "Z"):
        return False
    j = 2
    while j < len(rest) and (rest[j].isascii() and (rest[j].isalnum() or rest[j] == "-")):
        j += 1
    return j == len(rest) or rest[j] in _JS_SPACE or rest[j] in "/>"


def _card_warnings(spec: dict, attrs: list[tuple[str, str]], known: set, seen: set, out: list[dict]) -> None:
    """A canonical insert's attribute and investigation warnings, each once."""
    tag = spec["tag"]
    for name, _ in attrs:
        if name not in spec["attributes"] and ("attribute", name) not in seen:
            seen.add(("attribute", name))
            out.append({"code": "unknown_attribute",
                        "message": f'<{tag}> has an unknown attribute "{name}"; the viewer ignores it',
                        "attribute": name})
    ref = next((v for n, v in attrs if n == spec["reference"]), "")
    if ref not in known and ("investigation", ref) not in seen:
        seen.add(("investigation", ref))
        message = (f"<{tag}> names no investigation; {_UNAVAILABLE}" if not ref else
                   f'<{tag}> names "{ref}", which is not an investigation in this project; {_UNAVAILABLE}')
        out.append({"code": "unknown_investigation", "message": message, "investigation": ref})


# --- a canonical insert's attributes, as the HTML parser reads its start tag ---
def _start_tag(text: str, at: int) -> tuple[str, list[tuple[str, str]], int] | None:
    """Tag name (at its first letter), attributes and the index after ``>``."""
    i = at
    while i < len(text) and text[i] not in _SPACE and text[i] not in "/>":
        i += 1
    name = _lower(text[at:i]).replace("\0", "�")
    attrs: list[tuple[str, str]] = []
    while True:
        while i < len(text) and text[i] in _SPACE:
            i += 1
        if i >= len(text):
            return None
        if text[i] == ">":
            return name, attrs, i + 1
        if text[i] == "/":
            i += 1
            continue
        name_start = i
        i += 1  # a leading '=' belongs to the name
        while i < len(text) and text[i] not in _SPACE and text[i] not in "/>=":
            i += 1
        attr = _lower(text[name_start:i])
        j = i
        while j < len(text) and text[j] in _SPACE:
            j += 1
        value = ""
        if j < len(text) and text[j] == "=":
            j += 1
            while j < len(text) and text[j] in _SPACE:
                j += 1
            if j >= len(text):
                return None
            if text[j] in "\"'":
                close = text.find(text[j], j + 1)
                if close < 0:
                    return None
                value = decode(text[j + 1:close])
                i = close + 1
            else:
                start = j
                while j < len(text) and text[j] not in _SPACE and text[j] != ">":
                    j += 1
                value = decode(text[start:j])
                i = j
        if all(n != attr for n, _ in attrs):
            attrs.append((attr, value))


_NAMED = {"amp": "&", "lt": "<", "gt": ">", "quot": '"', "apos": "'"}
#: Legacy names the HTML parser also reads without ``;`` (here, the subset
#: of :data:`_NAMED` that has a legacy form).
_LEGACY = ("amp", "quot", "lt", "gt")
#: Numeric references to C1 controls that HTML reads as windows-1252.
_WINDOWS_1252 = {
    0x80: 0x20AC, 0x82: 0x201A, 0x83: 0x0192, 0x84: 0x201E, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021,
    0x88: 0x02C6, 0x89: 0x2030, 0x8A: 0x0160, 0x8B: 0x2039, 0x8C: 0x0152, 0x8E: 0x017D, 0x91: 0x2018,
    0x92: 0x2019, 0x93: 0x201C, 0x94: 0x201D, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02DC,
    0x99: 0x2122, 0x9A: 0x0161, 0x9B: 0x203A, 0x9C: 0x0153, 0x9E: 0x017E, 0x9F: 0x0178,
}
_HEX = "0123456789abcdefABCDEF"


def _numeric(value: str, at: int) -> tuple[str, int] | None:
    """A numeric reference at ``value[at] == '#'``: (character, end) or None."""
    i = at + 1
    hexadecimal = i < len(value) and value[i] in "xX"
    if hexadecimal:
        i += 1
    digits = _HEX if hexadecimal else "0123456789"
    start = i
    code = 0
    while i < len(value) and value[i] in digits:
        code = min(code * (16 if hexadecimal else 10) + int(value[i], 16), 0x110000)
        i += 1
    if i == start:
        return None
    if i < len(value) and value[i] == ";":
        i += 1
    if code == 0 or code > 0x10FFFF or 0xD800 <= code <= 0xDFFF:
        return "�", i
    return chr(_WINDOWS_1252.get(code, code)), i


def decode(value: str) -> str:
    """Character references in an attribute value, as the HTML parser reads
    them: numeric ones (with or without ``;``), the five XML names with
    ``;``, and ``&amp``, ``&quot``, ``&lt``, ``&gt`` without one unless a
    letter, digit or ``=`` follows. Other names stay as written; insert ids
    are plain ASCII."""
    out = []
    i = 0
    while True:
        at = value.find("&", i)
        if at < 0:
            out.append(value[i:])
            return "".join(out)
        out.append(value[i:at])
        if value.startswith("#", at + 1):
            found = _numeric(value, at + 1)
            if found is not None:
                out.append(found[0])
                i = found[1]
                continue
        else:
            semi = value.find(";", at + 1)
            name = value[at + 1:semi] if semi >= 0 else None
            if name in _NAMED:
                out.append(_NAMED[name])
                i = semi + 1
                continue
            legacy = next((n for n in _LEGACY if value.startswith(n, at + 1)), None)
            if legacy is not None:
                after = value[at + 1 + len(legacy):at + 2 + len(legacy)]
                if not (after.isascii() and (after.isalnum() or after == "=")):
                    out.append(_NAMED[legacy])
                    i = at + 1 + len(legacy)
                    continue
        out.append("&")
        i = at + 1
