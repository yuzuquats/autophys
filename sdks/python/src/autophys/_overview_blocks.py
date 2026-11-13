"""Where the viewer puts insert cards: a port of its Markdown block pass.

The browser renders an overview with std-documentation, whose parser is
markdown-it 14.1.0 (``commonmark`` preset, ``html`` on, tables on) as bundled
in ``html/routes/js/prosemirror.min.js``, plus one block rule per insert from
tento's ``tento-plugins-js/prosemirror/src/markdown.ts``. That rule runs
before ``html_block``, is registered without ``alt`` (so it never interrupts
a paragraph, a table or a reference), and fires on any block line whose
trimmed text starts with ``<`` plus the tag, case-sensitively and without a
tag-boundary check. Inside blockquotes and list items it fires as well.

Only the block structure is ported: the rules decide which lines start which
blocks, and nothing here builds inline content. :func:`blocks` returns, in
document order:

- ``("card", spec, line, content, end, closed)``: a line the insert rule
  turned into a card; ``content`` is the token text the viewer hands to the
  HTML parser, ``end`` the first line after it and ``closed`` whether a line
  held the closing tag.
- ``("continued", spec, line)``: a line that starts like an insert but
  continues a paragraph, table, setext heading or link reference, so the
  viewer renders it as (ignored) inline HTML and shows no card.
- ``("html_block", None, line)``: an HTML block. The viewer's parser has no
  handler for it, so the whole document fails to display.

``sdks/rust/src/workbook/overview_blocks.rs`` is the same port; the shared
vectors in ``tests/conformance/overview/cases.json`` pin both, and
``html/routes/overview-vectors.deno.test.ts`` runs the real bundle over them.
"""

from __future__ import annotations

import re

#: The viewer's built-in insert (std-documentation's LISP_INSERT), registered
#: before the app's inserts. It never warns but takes lines like any card.
BUILTIN_TAGS = ("std-lisp-example",)

_MAX_NESTING = 20  # markdown-it's commonmark preset
_MAX_AUTOCOMPLETED_CELLS = 65536

#: ECMAScript WhiteSpace and LineTerminator: what String.prototype.trim and
#: ``\s`` remove or match.
JS_SPACE = ("\t\n\v\f\r            "
            "      　﻿")
_S = "[" + JS_SPACE.replace("\\", "") + "]"

_BLOCK_NAMES = (
    "address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|"
    "div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|"
    "iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|"
    "table|tbody|td|tfoot|th|thead|title|tr|track|ul")
_ATTR = (r"(?:" + _S + r"+[a-zA-Z_:][a-zA-Z0-9:._-]*(?:" + _S + r"*=" + _S
         + r"*(?:[^\"'=<>`\x00-\x20]+|'[^']*'|\"[^\"]*\"))?)")
_OPEN_CLOSE = r"(?:<[A-Za-z][A-Za-z0-9\-]*" + _ATTR + "*" + _S + r"*/?>|</[A-Za-z][A-Za-z0-9\-]*" + _S + r"*>)"
_CI = re.IGNORECASE | re.ASCII  # ASCII case folding, as JavaScript's /i without /u
# (start, end, can interrupt a paragraph): markdown-it 14.1.0's HTML_SEQUENCES.
_HTML_SEQUENCES = (
    (re.compile(r"<(?:script|pre|style|textarea)(?=" + _S + r"|>|\Z)", _CI),
     re.compile(r"</(?:script|pre|style|textarea)>", _CI), True),
    (re.compile(r"<!--"), re.compile(r"-->"), True),
    (re.compile(r"<\?"), re.compile(r"\?>"), True),
    (re.compile(r"<![A-Z]"), re.compile(r">"), True),
    (re.compile(r"<!\[CDATA\["), re.compile(r"\]\]>"), True),
    (re.compile(r"</?(?:" + _BLOCK_NAMES + r")(?=" + _S + r"|/?>|\Z)", _CI), None, True),
    (re.compile(_OPEN_CLOSE + _S + r"*\Z"), None, False),
)
_DELIMITER_CELL = re.compile(r":?-+:?\Z")
_BAD_PROTOCOL = re.compile(r"(?:vbscript|javascript|file|data):")
_GOOD_DATA = re.compile(r"data:image/(?:gif|png|jpeg|webp);")


def js_trim(text: str) -> str:
    return text.strip(JS_SPACE)


def normalize(markdown: str) -> str:
    """markdown-it's first core rule: CRLF and CR become LF, NUL becomes U+FFFD."""
    return markdown.replace("\r\n", "\n").replace("\r", "\n").replace("\0", "�")


def _space(ch: str) -> bool:
    return ch == " " or ch == "\t"


def _code(text: str, i: int) -> str:
    """``charCodeAt`` past the end is NaN, which equals nothing."""
    return text[i] if 0 <= i < len(text) else ""


class _State:
    def __init__(self, src: str, tags: tuple[str, ...]):
        self.src = src
        self.tags = tags
        self.b, self.e, self.t, self.s, self.bs = [], [], [], [], []
        start = pos = indent = offset = 0
        found = False
        n = len(src)
        while pos < n:
            ch = src[pos]
            if not found:
                if _space(ch):
                    indent += 1
                    offset += 4 - offset % 4 if ch == "\t" else 1
                    pos += 1
                    continue
                found = True
            if ch == "\n" or pos == n - 1:
                if ch != "\n":
                    pos += 1
                self.b.append(start)
                self.e.append(pos)
                self.t.append(indent)
                self.s.append(offset)
                self.bs.append(0)
                found = False
                indent = offset = 0
                start = pos + 1
            pos += 1
        for arr, v in ((self.b, n), (self.e, n), (self.t, 0), (self.s, 0), (self.bs, 0)):
            arr.append(v)
        self.line_max = len(self.b) - 1
        self.blk = 0
        self.line = 0
        self.parent = "root"
        self.level = 0
        self.list_indent = -1
        self.out: list[tuple] = []
        cards = [self._card_rule(tag) for tag in tags]
        self.rules = [self.table, self.code, self.fence, self.blockquote, self.hr, self.list, self.reference,
                      *cards, self.html_block, self.heading, self.lheading, self.paragraph]
        self.paragraph_terms = [self.table, self.fence, self.blockquote, self.hr, self.list, self.html_block,
                                self.heading]
        self.reference_terms = self.paragraph_terms
        self.blockquote_terms = [self.fence, self.blockquote, self.hr, self.list, self.html_block, self.heading]
        self.list_terms = [self.fence, self.blockquote, self.hr]

    # --- StateBlock helpers ------------------------------------------------
    def empty(self, line: int) -> bool:
        return self.b[line] + self.t[line] >= self.e[line]

    def skip_empty(self, line: int) -> int:
        while line < self.line_max and self.b[line] + self.t[line] >= self.e[line]:
            line += 1
        return line

    def skip_spaces(self, pos: int) -> int:
        while pos < len(self.src) and _space(self.src[pos]):
            pos += 1
        return pos

    def skip_spaces_back(self, pos: int, floor: int) -> int:
        if pos <= floor:
            return pos
        while pos > floor:
            pos -= 1
            if not _space(self.src[pos]):
                return pos + 1
        return pos

    def skip_chars(self, pos: int, ch: str) -> int:
        while pos < len(self.src) and self.src[pos] == ch:
            pos += 1
        return pos

    def skip_chars_back(self, pos: int, ch: str, floor: int) -> int:
        if pos <= floor:
            return pos
        while pos > floor:
            pos -= 1
            if self.src[pos] != ch:
                return pos + 1
        return pos

    def text(self, line: int) -> str:
        return self.src[self.b[line] + self.t[line]:self.e[line]]

    def looks_like_insert(self, line: int) -> str | None:
        """The insert tag a line would open if it started a block."""
        text = self.text(line).lstrip(JS_SPACE)
        return next((tag for tag in self.tags if text.startswith("<" + tag)), None)

    def mark_continued(self, first: int, end: int) -> None:
        for line in range(first, end):
            tag = self.looks_like_insert(line)
            if tag is not None:
                self.out.append(("continued", tag, line))

    def terminates(self, rules, line: int, end: int) -> bool:
        return any(rule(line, end, True) for rule in rules)

    # --- ParserBlock.tokenize --------------------------------------------
    def tokenize(self, start: int, end: int) -> None:
        line = start
        while line < end:
            self.line = line = self.skip_empty(line)
            if line >= end or self.s[line] < self.blk:
                break
            if self.level >= _MAX_NESTING:
                self.line = end
                break
            for rule in self.rules:
                if rule(line, end, False):
                    break
            line = self.line
            if line < end and self.empty(line):
                line += 1
                self.line = line

    # --- rules, in the ruler's order -------------------------------------
    def table(self, start: int, end: int, silent: bool) -> bool:
        if start + 2 > end:
            return False
        nxt = start + 1
        if self.s[nxt] < self.blk or self.s[nxt] - self.blk >= 4:
            return False
        pos = self.b[nxt] + self.t[nxt]
        if pos >= self.e[nxt]:
            return False
        first = self.src[pos]
        pos += 1
        if first not in "|-:" or pos >= self.e[nxt]:
            return False
        second = self.src[pos]
        pos += 1
        if (second not in "|-:" and not _space(second)) or (first == "-" and _space(second)):
            return False
        while pos < self.e[nxt]:
            if self.src[pos] not in "|-:" and not _space(self.src[pos]):
                return False
            pos += 1
        cells = self.src[self.b[nxt] + self.t[nxt]:self.e[nxt]].split("|")
        columns = 0
        for i, cell in enumerate(cells):
            cell = js_trim(cell)
            if not cell:
                if i == 0 or i == len(cells) - 1:
                    continue
                return False
            if not _DELIMITER_CELL.match(cell):
                return False
            columns += 1
        header = js_trim(self.text(start))
        if "|" not in header or self.s[start] - self.blk >= 4:
            return False
        count = _row_cells(header)
        if count == 0 or count != columns:
            return False
        if silent:
            return True
        old_parent = self.parent
        self.parent = "table"
        self.mark_continued(start, start + 1)
        autocompleted = 0
        nxt = start + 2
        while nxt < end and not self.s[nxt] < self.blk:
            if self.terminates(self.blockquote_terms, nxt, end):
                break
            row = js_trim(self.text(nxt))
            if not row or self.s[nxt] - self.blk >= 4:
                break
            autocompleted += columns - _row_cells(row)
            if autocompleted > _MAX_AUTOCOMPLETED_CELLS:
                break
            self.mark_continued(nxt, nxt + 1)
            nxt += 1
        self.parent = old_parent
        self.line = nxt
        return True

    def code(self, start: int, end: int, silent: bool) -> bool:
        if self.s[start] - self.blk < 4:
            return False
        nxt = last = start + 1
        while nxt < end:
            if self.empty(nxt):
                nxt += 1
                continue
            if self.s[nxt] - self.blk >= 4:
                nxt += 1
                last = nxt
                continue
            break
        self.line = last
        return True

    def fence(self, start: int, end: int, silent: bool) -> bool:
        pos = self.b[start] + self.t[start]
        mx = self.e[start]
        if self.s[start] - self.blk >= 4 or pos + 3 > mx:
            return False
        marker = self.src[pos]
        if marker != "~" and marker != "`":
            return False
        mem = pos
        pos = self.skip_chars(pos, marker)
        length = pos - mem
        if length < 3:
            return False
        if marker == "`" and "`" in self.src[pos:mx]:
            return False
        if silent:
            return True
        nxt = start
        closed = False
        while True:
            nxt += 1
            if nxt >= end:
                break
            pos = mem = self.b[nxt] + self.t[nxt]
            mx = self.e[nxt]
            if pos < mx and self.s[nxt] < self.blk:
                break
            if _code(self.src, pos) != marker:
                continue
            if self.s[nxt] - self.blk >= 4:
                continue
            pos = self.skip_chars(pos, marker)
            if pos - mem < length:
                continue
            pos = self.skip_spaces(pos)
            if pos < mx:
                continue
            closed = True
            break
        self.line = nxt + (1 if closed else 0)
        return True

    def blockquote(self, start: int, end: int, silent: bool) -> bool:
        pos = self.b[start] + self.t[start]
        mx = self.e[start]
        old_line_max = self.line_max
        if self.s[start] - self.blk >= 4 or _code(self.src, pos) != ">":
            return False
        if silent:
            return True
        old_b, old_bs, old_s, old_t = [], [], [], []
        old_parent = self.parent
        self.parent = "blockquote"
        last_empty = False
        nxt = start
        while nxt < end:
            outdented = self.s[nxt] < self.blk
            pos = self.b[nxt] + self.t[nxt]
            mx = self.e[nxt]
            if pos >= mx:
                break
            if self.src[pos] == ">" and not outdented:
                pos += 1
                initial = self.s[nxt] + 1
                if _code(self.src, pos) == " ":
                    pos += 1
                    initial += 1
                    adjust_tab = False
                    space_after = True
                elif _code(self.src, pos) == "\t":
                    space_after = True
                    if (self.bs[nxt] + initial) % 4 == 3:
                        pos += 1
                        initial += 1
                        adjust_tab = False
                    else:
                        adjust_tab = True
                else:
                    space_after = False
                    adjust_tab = False
                offset = initial
                old_b.append(self.b[nxt])
                self.b[nxt] = pos
                while pos < mx:
                    ch = self.src[pos]
                    if ch == "\t":
                        offset += 4 - (offset + self.bs[nxt] + (1 if adjust_tab else 0)) % 4
                    elif ch == " ":
                        offset += 1
                    else:
                        break
                    pos += 1
                last_empty = pos >= mx
                old_bs.append(self.bs[nxt])
                self.bs[nxt] = self.s[nxt] + 1 + (1 if space_after else 0)
                old_s.append(self.s[nxt])
                self.s[nxt] = offset - initial
                old_t.append(self.t[nxt])
                self.t[nxt] = pos - self.b[nxt]
                nxt += 1
                continue
            if last_empty:
                break
            if self.terminates(self.blockquote_terms, nxt, end):
                self.line_max = nxt
                if self.blk != 0:
                    old_b.append(self.b[nxt])
                    old_bs.append(self.bs[nxt])
                    old_t.append(self.t[nxt])
                    old_s.append(self.s[nxt])
                    self.s[nxt] -= self.blk
                break
            old_b.append(self.b[nxt])
            old_bs.append(self.bs[nxt])
            old_t.append(self.t[nxt])
            old_s.append(self.s[nxt])
            self.s[nxt] = -1
            nxt += 1
        old_indent = self.blk
        self.blk = 0
        self.level += 1
        self.tokenize(start, nxt)
        self.level -= 1
        self.line_max = old_line_max
        self.parent = old_parent
        for i in range(len(old_t)):
            self.b[i + start] = old_b[i]
            self.t[i + start] = old_t[i]
            self.s[i + start] = old_s[i]
            self.bs[i + start] = old_bs[i]
        self.blk = old_indent
        return True

    def hr(self, start: int, end: int, silent: bool) -> bool:
        mx = self.e[start]
        if self.s[start] - self.blk >= 4:
            return False
        pos = self.b[start] + self.t[start]
        marker = _code(self.src, pos)
        pos += 1
        if marker not in ("*", "-", "_"):
            return False
        count = 1
        while pos < mx:
            ch = self.src[pos]
            pos += 1
            if ch != marker and not _space(ch):
                return False
            if ch == marker:
                count += 1
        if count < 3:
            return False
        if silent:
            return True
        self.line = start + 1
        return True

    def _bullet(self, line: int) -> int:
        mx = self.e[line]
        pos = self.b[line] + self.t[line]
        marker = _code(self.src, pos)
        pos += 1
        if marker not in ("*", "-", "+"):
            return -1
        if pos < mx and not _space(self.src[pos]):
            return -1
        return pos

    def _ordered(self, line: int) -> int:
        start = pos = self.b[line] + self.t[line]
        mx = self.e[line]
        if pos + 1 >= mx:
            return -1
        ch = self.src[pos]
        pos += 1
        if not "0" <= ch <= "9":
            return -1
        while True:
            if pos >= mx:
                return -1
            ch = self.src[pos]
            pos += 1
            if "0" <= ch <= "9":
                if pos - start >= 10:
                    return -1
                continue
            if ch in ").":
                break
            return -1
        if pos < mx and not _space(self.src[pos]):
            return -1
        return pos

    def list(self, start: int, end: int, silent: bool) -> bool:
        line = start
        if self.s[line] - self.blk >= 4:
            return False
        if self.list_indent >= 0 and self.s[line] - self.list_indent >= 4 and self.s[line] < self.blk:
            return False
        interrupts = silent and self.parent == "paragraph" and self.s[line] >= self.blk
        marker_start = 0
        pos_after = self._ordered(line)
        if pos_after >= 0:
            ordered = True
            marker_start = self.b[line] + self.t[line]
            if interrupts and int(self.src[marker_start:pos_after - 1]) != 1:
                return False
        else:
            pos_after = self._bullet(line)
            if pos_after < 0:
                return False
            ordered = False
        if interrupts and self.skip_spaces(pos_after) >= self.e[line]:
            return False
        if silent:
            return True
        marker = self.src[pos_after - 1]
        old_parent = self.parent
        self.parent = "list"
        self.level += 1
        while line < end:
            pos = pos_after
            mx = self.e[line]
            initial = self.s[line] + pos_after - (self.b[line] + self.t[line])
            offset = initial
            while pos < mx:
                ch = self.src[pos]
                if ch == "\t":
                    offset += 4 - (offset + self.bs[line]) % 4
                elif ch == " ":
                    offset += 1
                else:
                    break
                pos += 1
            content_start = pos
            indent_after = 1 if content_start >= mx else offset - initial
            if indent_after > 4:
                indent_after = 1
            indent = initial + indent_after
            old_t, old_s, old_list_indent = self.t[line], self.s[line], self.list_indent
            self.list_indent = self.blk
            self.blk = indent
            self.t[line] = content_start - self.b[line]
            self.s[line] = offset
            self.level += 1
            if content_start >= mx and self.empty(line + 1):
                self.line = min(self.line + 2, end)
            else:
                self.tokenize(line, end)
            self.level -= 1
            self.blk = self.list_indent
            self.list_indent = old_list_indent
            self.t[line] = old_t
            self.s[line] = old_s
            line = self.line
            if line >= end or self.s[line] < self.blk or self.s[line] - self.blk >= 4:
                break
            if self.terminates(self.list_terms, line, end):
                break
            if ordered:
                pos_after = self._ordered(line)
                if pos_after < 0:
                    break
                marker_start = self.b[line] + self.t[line]
            else:
                pos_after = self._bullet(line)
                if pos_after < 0:
                    break
            if marker != self.src[pos_after - 1]:
                break
        self.level -= 1
        self.line = line
        self.parent = old_parent
        return True

    def reference(self, start: int, end: int, silent: bool) -> bool:
        pos = self.b[start] + self.t[start]
        mx = self.e[start]
        nxt = start + 1
        if self.s[start] - self.blk >= 4 or _code(self.src, pos) != "[":
            return False

        def continuation(line: int) -> str | None:
            line_max = self.line_max
            if line >= line_max or self.empty(line):
                return None
            lazy = self.s[line] - self.blk > 3 or self.s[line] < 0
            if not lazy:
                old_parent = self.parent
                self.parent = "reference"
                stop = self.terminates(self.reference_terms, line, line_max)
                self.parent = old_parent
                if stop:
                    return None
            return self.src[self.b[line] + self.t[line]:self.e[line] + 1]

        text = self.src[pos:mx + 1]
        length = len(text)
        label_end = -1
        i = 1
        while i < length:
            ch = text[i]
            if ch == "[":
                return False
            if ch == "]":
                label_end = i
                break
            if ch == "\n":
                more = continuation(nxt)
                if more is not None:
                    text += more
                    length = len(text)
                    nxt += 1
            elif ch == "\\":
                i += 1
                if i < length and text[i] == "\n":
                    more = continuation(nxt)
                    if more is not None:
                        text += more
                        length = len(text)
                        nxt += 1
            i += 1
        if label_end < 0 or _code(text, label_end + 1) != ":":
            return False
        i = label_end + 2
        while i < length:
            ch = text[i]
            if ch == "\n":
                more = continuation(nxt)
                if more is not None:
                    text += more
                    length = len(text)
                    nxt += 1
            elif not _space(ch):
                break
            i += 1
        ok, dest, i = _link_destination(text, i, length)
        if not ok or not _valid_link(dest):
            return False
        dest_end = i
        dest_next = nxt
        before_title = i
        while i < length:
            ch = text[i]
            if ch == "\n":
                more = continuation(nxt)
                if more is not None:
                    text += more
                    length = len(text)
                    nxt += 1
            elif not _space(ch):
                break
            i += 1
        title = _link_title(text, i, length, None)
        while title["can_continue"]:
            more = continuation(nxt)
            if more is None:
                break
            text += more
            i = length
            length = len(text)
            nxt += 1
            title = _link_title(text, i, length, title)
        if i < length and before_title != i and title["ok"]:
            has_title = title["str"] != ""
            i = title["pos"]
        else:
            has_title = False
            i = dest_end
            nxt = dest_next
        while i < length and _space(text[i]):
            i += 1
        if i < length and text[i] != "\n" and has_title:
            has_title = False
            i = dest_end
            nxt = dest_next
            while i < length and _space(text[i]):
                i += 1
        if i < length and text[i] != "\n":
            return False
        if not js_trim(re.sub("[" + JS_SPACE + "]+", " ", text[1:label_end])):
            return False
        if not silent:
            self.mark_continued(start + 1, nxt)
            self.line = nxt
        return True

    def _card_rule(self, tag: str):
        opening = "<" + tag
        closing = "</" + tag + ">"

        def card(start: int, end: int, silent: bool) -> bool:
            text = self.text(start)
            if not js_trim(text).startswith(opening):
                return False
            if silent:
                return True
            if closing in text:
                self.out.append(("card", tag, start, text, start + 1, True))
                self.line = start + 1
                return True
            nxt = start + 1
            content = text
            closed = False
            while nxt < end:
                line = self.text(nxt)
                content += "\n" + line
                if closing in line:
                    nxt += 1
                    closed = True
                    break
                nxt += 1
            self.out.append(("card", tag, start, content, nxt, closed))
            self.line = nxt
            return True

        return card

    def html_block(self, start: int, end: int, silent: bool) -> bool:
        if self.s[start] - self.blk >= 4:
            return False
        text = self.text(start)
        if not text.startswith("<"):
            return False
        for opener, closer, interrupts in _HTML_SEQUENCES:
            if opener.match(text):
                break
        else:
            return False
        if silent:
            return interrupts
        nxt = start + 1

        def closes(line_text: str) -> bool:
            return line_text == "" if closer is None else closer.search(line_text) is not None

        if not closes(text):
            while nxt < end and not self.s[nxt] < self.blk:
                line = self.text(nxt)
                if closes(line):
                    if line:
                        nxt += 1
                    break
                nxt += 1
        self.out.append(("html_block", None, start))
        self.line = nxt
        return True

    def heading(self, start: int, end: int, silent: bool) -> bool:
        pos = self.b[start] + self.t[start]
        mx = self.e[start]
        if self.s[start] - self.blk >= 4:
            return False
        if _code(self.src, pos) != "#" or pos >= mx:
            return False
        level = 1
        pos += 1
        ch = _code(self.src, pos)
        while ch == "#" and pos < mx and level <= 6:
            level += 1
            pos += 1
            ch = _code(self.src, pos)
        if level > 6 or (pos < mx and not _space(ch)):
            return False
        if silent:
            return True
        self.line = start + 1
        return True

    def lheading(self, start: int, end: int, silent: bool) -> bool:
        if self.s[start] - self.blk >= 4:
            return False
        old_parent = self.parent
        self.parent = "paragraph"
        level = 0
        nxt = start + 1
        while nxt < end and not self.empty(nxt):
            if self.s[nxt] - self.blk > 3:
                nxt += 1
                continue
            if self.s[nxt] >= self.blk:
                pos = self.b[nxt] + self.t[nxt]
                mx = self.e[nxt]
                if pos < mx:
                    marker = self.src[pos]
                    if marker in "-=":
                        pos = self.skip_spaces(self.skip_chars(pos, marker))
                        if pos >= mx:
                            level = 1 if marker == "=" else 2
                            break
            if self.s[nxt] < 0:
                nxt += 1
                continue
            if self.terminates(self.paragraph_terms, nxt, end):
                break
            nxt += 1
        if not level:
            # markdown-it 14.1.0 leaves parentType as "paragraph" here.
            return False
        self.mark_continued(start + 1, nxt)
        self.line = nxt + 1
        self.parent = old_parent
        return True

    def paragraph(self, start: int, end: int, silent: bool) -> bool:
        old_parent = self.parent
        nxt = start + 1
        self.parent = "paragraph"
        while nxt < end and not self.empty(nxt):
            if self.s[nxt] - self.blk > 3 or self.s[nxt] < 0:
                nxt += 1
                continue
            if self.terminates(self.paragraph_terms, nxt, end):
                break
            nxt += 1
        self.mark_continued(start + 1, nxt)
        self.line = nxt
        self.parent = old_parent
        return True


def _row_cells(row: str) -> int:
    """markdown-it's escapedSplit, less its empty first and last cells: the count."""
    cells = []
    current = ""
    last = 0
    escaped = False
    for i, ch in enumerate(row):
        if ch == "|":
            if escaped:
                current += row[last:i - 1]
                last = i
            else:
                cells.append(current + row[last:i])
                current = ""
                last = i + 1
        escaped = ch == "\\"
    cells.append(current + row[last:])
    if cells and cells[0] == "":
        cells.pop(0)
    if cells and cells[-1] == "":
        cells.pop()
    return len(cells)


def _link_destination(text: str, pos: int, end: int) -> tuple[bool, str, int]:
    start = pos
    if _code(text, pos) == "<":
        pos += 1
        while pos < end:
            ch = text[pos]
            if ch in "\n<":
                return False, "", 0
            if ch == ">":
                return True, _unescape(text[start + 1:pos]), pos + 1
            if ch == "\\" and pos + 1 < end:
                pos += 2
                continue
            pos += 1
        return False, "", 0
    depth = 0
    while pos < end:
        ch = text[pos]
        if ch == " " or ord(ch) < 0x20 or ch == "\x7f":
            break
        if ch == "\\" and pos + 1 < end:
            if text[pos + 1] == " ":
                break
            pos += 2
            continue
        if ch == "(":
            depth += 1
            if depth > 32:
                return False, "", 0
        if ch == ")":
            if depth == 0:
                break
            depth -= 1
        pos += 1
    if start == pos or depth != 0:
        return False, "", 0
    return True, _unescape(text[start:pos]), pos


def _link_title(text: str, pos: int, end: int, prev: dict | None) -> dict:
    out = {"ok": False, "can_continue": False, "pos": 0, "str": "", "marker": ""}
    start = pos
    if prev is not None:
        out["str"] = prev["str"]
        out["marker"] = prev["marker"]
    else:
        if pos >= end:
            return out
        ch = text[pos]
        if ch not in "\"'(":
            return out
        start += 1
        pos += 1
        out["marker"] = ")" if ch == "(" else ch
    while pos < end:
        ch = text[pos]
        if ch == out["marker"]:
            out["pos"] = pos + 1
            out["str"] += _unescape(text[start:pos])
            out["ok"] = True
            return out
        if ch == "(" and out["marker"] == ")":
            return out
        if ch == "\\" and pos + 1 < end:
            pos += 1
        pos += 1
    out["can_continue"] = True
    out["str"] += _unescape(text[start:pos])
    return out


_PUNCT = set("!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~")


def _unescape(text: str) -> str:
    """Backslash escapes and the character references that matter to
    validateLink (numeric ones and the five XML names)."""
    out = []
    i = 0
    while i < len(text):
        ch = text[i]
        if ch == "\\" and i + 1 < len(text) and text[i + 1] in _PUNCT:
            out.append(text[i + 1])
            i += 2
            continue
        if ch == "&":
            m = re.match(r"&(?:#[xX]([0-9a-fA-F]{1,6})|#([0-9]{1,7})|(amp|lt|gt|quot|apos));", text[i:])
            if m:
                if m.group(3):
                    out.append({"amp": "&", "lt": "<", "gt": ">", "quot": '"', "apos": "'"}[m.group(3)])
                else:
                    code = int(m.group(1), 16) if m.group(1) else int(m.group(2))
                    valid = 0 < code <= 0x10FFFF and not 0xD800 <= code <= 0xDFFF
                    out.append(chr(code) if valid else m.group(0))
                i += len(m.group(0))
                continue
        out.append(ch)
        i += 1
    return "".join(out)


def _valid_link(url: str) -> bool:
    """markdown-it's validateLink (after normalizeLink, which keeps the scheme)."""
    lowered = js_trim(url).lower()
    return not _BAD_PROTOCOL.match(lowered) or _GOOD_DATA.match(lowered) is not None


def blocks(markdown: str, tags: tuple[str, ...]) -> list[tuple]:
    """The viewer's insert blocks in ``markdown`` (see the module docstring);
    ``tags`` are the app's insert tags, after :data:`BUILTIN_TAGS`. Lines are
    0-based in the normalized text."""
    src = normalize(markdown)
    if not src:
        return []
    state = _State(src, BUILTIN_TAGS + tuple(tags))
    state.tokenize(0, state.line_max)
    return state.out
