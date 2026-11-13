"""Project overviews: the checks every overview write shares (OV-3, OV-4).

An overview is one Markdown research note per project, kept as an
append-only history in workbook format 3 (``WorkbookStore.put_overview``).
A write is refused only for an empty or whitespace-only body, more than
:data:`MAX_OVERVIEW_BYTES` of UTF-8, invalid UTF-8 or a missing author.
Everything else is advisory: :func:`check_overview` returns warnings for
inserts that name an investigation the workbook does not hold or use an
attribute the viewer does not know, and for Markdown the viewer will not
render as written (OV-9). The tags and attribute keys come from
``investigation-inserts.json``, a byte-for-byte copy of
``html/ui/investigation-inserts.json`` (the browser's list), so the Rust SDK,
this SDK and the viewer agree. Where a card renders is decided by
:mod:`autophys._overview_blocks`, a port of the viewer's block parser. The
rules mirror ``sdks/rust/src/workbook/overview.rs``;
``tests/conformance/overview/cases.json`` pins both.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, Callable, Iterable

from . import _overview_blocks
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
_TAGS = tuple(i["tag"] for i in _INSERTS)
_BY_TAG = {i["tag"]: i for i in _INSERTS}


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
    investigations ``known``, in document order, each finding once.

    Cards are found where the viewer renders them (OV-9). Codes:
    ``unknown_attribute`` and ``unknown_investigation`` for a card;
    ``insert_in_paragraph`` for an insert line that continues the text above
    it and so renders no card; ``unclosed_insert`` for a card whose closing
    tag never comes, which hides the lines after it; and ``html_block`` for
    an HTML block, which stops the viewer displaying the whole overview.
    The last three carry the 1-based ``line``.
    """
    known = set(known)
    seen: set[tuple[str, str]] = set()
    out: list[dict] = []
    for found in _overview_blocks.blocks(markdown, _TAGS):
        kind, tag, line = found[0], found[1], found[2] + 1
        if kind == "html_block":
            out.append({"code": "html_block",
                        "message": f"line {line} starts an HTML block, which the viewer cannot display; "
                                   'it shows "The document could not be displayed" instead of the overview',
                        "line": line})
            continue
        spec = _BY_TAG.get(tag)
        if kind == "continued":
            if spec is None:
                continue  # the viewer's built-in insert is not ours to place
            out.append({"code": "insert_in_paragraph",
                        "message": f"<{tag}> on line {line} continues the text above it, so the viewer shows "
                                   "no card; put a blank line before it",
                        "line": line})
            continue
        _, _, _, content, end, closed = found
        if spec is not None:
            _card_warnings(spec, element_attributes(content, _lower(tag)) or [], known, seen, out)
        if _hides_lines(content, tag):
            until = f"is not closed until line {end}" if closed else f"is never closed with </{tag}>"
            out.append({"code": "unclosed_insert",
                        "message": f"<{tag}> on line {line} {until}, so the viewer hides lines {line + 1} to {end}",
                        "line": line})
    return out


def _hides_lines(content: str, tag: str) -> bool:
    """Whether a card token runs past its first line and holds text besides
    its start tag and closing tag: the viewer shows none of that text. A start
    tag with its attributes over several lines hides nothing; one cut off by
    the end of the block hides every line after it."""
    if "\n" not in content:
        return False
    at = content.find("<" + tag)
    parsed = _start_tag(content, at + 1) if at >= 0 else None
    if parsed is None:
        return any(_overview_blocks.js_trim(s) for s in content.split("\n")[1:])
    rest = content[parsed[2]:].replace(f"</{tag}>", "", 1)
    return _overview_blocks.js_trim(rest) != ""


def _card_warnings(spec: dict, attrs: list[tuple[str, str]], known: set, seen: set, out: list[dict]) -> None:
    """A rendered card's attribute and investigation warnings, each once."""
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


# --- the viewer's getAttrs: the first <tag> element of the card's HTML --------
_RAW_TEXT = ("script", "style", "xmp", "iframe", "noembed", "noframes", "noscript", "textarea", "title")


def _letter(ch: str) -> bool:
    return ("a" <= ch <= "z") or ("A" <= ch <= "Z")


def element_attributes(html: str, tag: str) -> list[tuple[str, str]] | None:
    """The attributes of the first ``tag`` element (lowercase) the HTML parser
    makes of ``html``, as the viewer's ``getAttrs`` reads them through
    ``innerHTML`` and ``querySelector``: names lowercased, values decoded,
    the first of a repeated name kept. None when there is no such element,
    which includes a tag cut off by the end of the text."""
    i = 0
    n = len(html)
    while True:
        lt = html.find("<", i)
        if lt < 0 or lt + 1 >= n:
            return None
        nxt = html[lt + 1]
        if nxt == "!":
            if html.startswith("<!--", lt):
                j = lt + 4
                if html.startswith(">", j):
                    i = j + 1
                    continue
                if html.startswith("->", j):
                    i = j + 2
                    continue
                ends = [k for k in (html.find("-->", j), html.find("--!>", j)) if k >= 0]
                if not ends:
                    return None
                k = min(ends)
                i = k + (3 if html.startswith("-->", k) else 4)
                continue
            end = html.find(">", lt + 2)
            if end < 0:
                return None
            i = end + 1
            continue
        if nxt == "?":
            end = html.find(">", lt + 2)
            if end < 0:
                return None
            i = end + 1
            continue
        closing = nxt == "/"
        start = lt + 2 if closing else lt + 1
        if start >= n:
            return None
        if not _letter(html[start]):
            if closing and html[start] == ">":
                i = start + 1
            elif closing:
                end = html.find(">", start)
                if end < 0:
                    return None
                i = end + 1
            else:
                i = lt + 1
            continue
        parsed = _start_tag(html, start)
        if parsed is None:
            return None
        name, attrs, i = parsed
        if closing:
            continue
        if name == tag:
            return attrs
        if name == "plaintext":
            return None
        if name in _RAW_TEXT:
            i = _raw_text_end(html, i, name)
            if i < 0:
                return None


def _raw_text_end(html: str, i: int, name: str) -> int:
    """Past the ``</name`` that ends a raw text element, or -1."""
    lowered = _lower(html)
    while True:
        k = lowered.find("</" + name, i)
        if k < 0:
            return -1
        after = k + 2 + len(name)
        if after >= len(html) or html[after] in _SPACE + "/>":
            return k
        i = after


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
