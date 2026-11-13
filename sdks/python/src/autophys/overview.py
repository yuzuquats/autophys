"""Project overviews: the checks every overview write shares (OV-3, OV-4).

An overview is one Markdown research note per project, kept as an
append-only history in workbook format 3 (``WorkbookStore.put_overview``).
A write is refused only for an empty or whitespace-only body, more than
:data:`MAX_OVERVIEW_BYTES` of UTF-8, invalid UTF-8 or a missing author.
Everything else is advisory: :func:`check_overview` returns warnings for
inserts that name an investigation the workbook does not hold, or that use
an attribute the viewer does not know. The tags and attribute keys come from
``investigation-inserts.json``, a byte-for-byte copy of
``html/ui/investigation-inserts.json`` (the browser's list), so the Rust SDK,
this SDK and the viewer agree. The rules mirror ``sdks/rust/src/workbook/overview.rs``;
``tests/conformance/overview/cases.json`` pins both.
"""

from __future__ import annotations

import hashlib
import json
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


_INSERTS = [{"tag": _lower(i["tag"]), "reference": i["reference"], "attributes": tuple(i["attributes"])}
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
    investigations ``known``, in document order, each finding once.

    An insert is an HTML block: its tag starts a line (after at most three
    spaces) outside fenced code, as the viewer's Markdown parser reads it.
    """
    known = set(known)
    seen: set[tuple[str, str]] = set()
    out: list[dict] = []
    for spec, attrs in _scan(markdown):
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
    return out


def _run(text: str, c: str) -> int:
    n = 0
    while n < len(text) and text[n] == c:
        n += 1
    return n


def _scan(markdown: str) -> list[tuple[dict, list[tuple[str, str]]]]:
    out = []
    fence: tuple[str, int] | None = None
    start = 0
    while start < len(markdown):
        end = markdown.find("\n", start)
        end = len(markdown) if end < 0 else end
        line = markdown[start:end]
        if line.endswith("\r"):
            line = line[:-1]
        indent = _run(line, " ")
        rest = line[indent:]
        if fence is not None:
            c, n = fence
            run = _run(rest, c)
            if indent <= 3 and run >= n and not rest[run:].strip(" \t"):
                fence = None
        elif indent <= 3 and (_run(rest, "`") >= 3 or _run(rest, "~") >= 3):
            c = rest[0]
            n = _run(rest, c)
            if c != "`" or "`" not in rest[n:]:
                fence = (c, n)
        elif indent <= 3 and rest.startswith("<"):
            found = _insert_at(markdown, start + indent)
            if found is not None:
                out.append(found)
        start = end + 1
    return out


def _insert_at(text: str, at: int):
    spec = None
    for s in _INSERTS:
        n = len(s["tag"]) + 1
        if _lower(text[at + 1:at + n]) == s["tag"] and (at + n >= len(text) or text[at + n] in _SPACE + "/>"):
            spec = s
            break
    if spec is None:
        return None
    i = at + len(spec["tag"]) + 1
    attrs: list[tuple[str, str]] = []
    while True:
        while i < len(text) and text[i] in _SPACE:
            i += 1
        if i >= len(text):
            return None
        if text[i] == ">":
            return spec, attrs
        if text[i] == "/":
            i += 1
            continue
        name_start = i
        i += 1  # a leading '=' belongs to the name
        while i < len(text) and text[i] not in _SPACE and text[i] not in "/>=":
            i += 1
        name = _lower(text[name_start:i])
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
                value = _decode(text[j + 1:close])
                i = close + 1
            else:
                start = j
                while j < len(text) and text[j] not in _SPACE and text[j] != ">":
                    j += 1
                value = _decode(text[start:j])
                i = j
        if all(n != name for n, _ in attrs):
            attrs.append((name, value))


_NAMED = {"amp": "&", "lt": "<", "gt": ">", "quot": '"', "apos": "'"}
_DIGITS = set("0123456789")
_HEX = set("0123456789abcdefABCDEF")


def _char(entity: str) -> str | None:
    if entity in _NAMED:
        return _NAMED[entity]
    if not entity.startswith("#"):
        return None
    n = entity[1:]
    if n[:1] in ("x", "X"):
        if not n[1:] or not set(n[1:]) <= _HEX:
            return None
        value = int(n[1:], 16)
    elif n and set(n) <= _DIGITS:
        value = int(n)
    else:
        return None
    if value > 0x10FFFF or 0xD800 <= value <= 0xDFFF:
        return None
    return chr(value)


def _decode(value: str) -> str:
    out = []
    rest = value
    while True:
        at = rest.find("&")
        if at < 0:
            break
        out.append(rest[:at])
        rest = rest[at:]
        semi = rest.find(";", 1)
        if semi < 0:
            break
        ch = _char(rest[1:semi])
        if ch is None:
            out.append("&")
            rest = rest[1:]
        else:
            out.append(ch)
            rest = rest[semi + 1:]
    out.append(rest)
    return "".join(out)
