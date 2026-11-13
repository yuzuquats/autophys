//! Where the viewer puts insert cards: a port of its Markdown block pass.
//!
//! The browser renders an overview with std-documentation, whose parser is
//! markdown-it 14.1.0 (`commonmark` preset, `html` on, tables on) as bundled
//! in `html/routes/js/prosemirror.min.js`, plus one block rule per insert
//! from tento's `tento-plugins-js/prosemirror/src/markdown.ts`. That rule
//! runs before `html_block`, is registered without `alt` (so it never
//! interrupts a paragraph, a table or a reference), and fires on any block
//! line whose trimmed text starts with `<` plus the tag, case-sensitively
//! and without a tag-boundary check. It fires inside blockquotes and list
//! items as well.
//!
//! Only the block structure is ported: the rules decide which lines start
//! which blocks, and nothing here builds inline content. Positions are UTF-8
//! byte offsets where markdown-it uses UTF-16 ones; every comparison is
//! against an ASCII character, so the two find the same lines.
//! `sdks/python/src/autophys/_overview_blocks.py` is the same port. The shared
//! vectors in `tests/conformance/overview/cases.json` pin both, and
//! `html/routes/overview-vectors.deno.test.ts` runs the real bundle over them.

/// The viewer's built-in insert (std-documentation's `LISP_INSERT`),
/// registered before the app's inserts. It never warns but takes lines like
/// any card.
pub(crate) const BUILTIN_TAGS: &[&str] = &["std-lisp-example"];

const MAX_NESTING: usize = 20; // markdown-it's commonmark preset
const MAX_AUTOCOMPLETED_CELLS: i64 = 65536;

/// ECMAScript WhiteSpace and LineTerminator: what `String.prototype.trim`
/// and `\s` remove or match.
pub(crate) fn js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

pub(crate) fn js_trim(s: &str) -> &str {
    s.trim_matches(js_space)
}

/// markdown-it's first core rule: CRLF and CR become LF, NUL becomes U+FFFD.
fn normalize(markdown: &str) -> String {
    markdown
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .replace('\0', "\u{fffd}")
}

/// One block the viewer makes of an insert-looking line. Lines are 0-based
/// in the normalized text.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Found {
    /// A line the insert rule turned into a card: `content` is the token text
    /// the viewer hands to the HTML parser, `end` the first line after it and
    /// `closed` whether a line held the closing tag.
    Card {
        tag: String,
        line: usize,
        content: String,
        end: usize,
        closed: bool,
    },
    /// A line that starts like an insert but continues a paragraph, table,
    /// setext heading or link reference: inline HTML the viewer ignores.
    Continued { tag: String, line: usize },
    /// An HTML block. The viewer's parser has no handler for one, so the
    /// whole document fails to display.
    HtmlBlock { line: usize },
}

/// The viewer's blocks for `markdown`, in document order; `tags` are the
/// app's insert tags, after [`BUILTIN_TAGS`].
pub(crate) fn blocks(markdown: &str, tags: &[&str]) -> Vec<Found> {
    let src = normalize(markdown);
    if src.is_empty() {
        return Vec::new();
    }
    let tags: Vec<String> = BUILTIN_TAGS
        .iter()
        .chain(tags)
        .map(|t| t.to_string())
        .collect();
    let mut state = State::new(&src, tags);
    let max = state.line_max;
    state.tokenize(0, max);
    state.out
}

#[derive(Clone, Copy)]
enum Rule {
    Table,
    Code,
    Fence,
    Blockquote,
    Hr,
    List,
    Reference,
    Card(usize),
    HtmlBlock,
    Heading,
    Lheading,
    Paragraph,
}

/// The rules whose `alt` names `paragraph` (and `reference`, the same list),
/// `blockquote` and `list`, in the ruler's order.
const PARAGRAPH_TERMS: &[Rule] = &[
    Rule::Table,
    Rule::Fence,
    Rule::Blockquote,
    Rule::Hr,
    Rule::List,
    Rule::HtmlBlock,
    Rule::Heading,
];
const BLOCKQUOTE_TERMS: &[Rule] = &[
    Rule::Fence,
    Rule::Blockquote,
    Rule::Hr,
    Rule::List,
    Rule::HtmlBlock,
    Rule::Heading,
];
const LIST_TERMS: &[Rule] = &[Rule::Fence, Rule::Blockquote, Rule::Hr];

#[derive(Clone, Copy, PartialEq)]
enum Parent {
    Root,
    Paragraph,
    Blockquote,
    List,
    Reference,
    Table,
}

fn space(b: u8) -> bool {
    b == b' ' || b == b'\t'
}

struct State<'a> {
    src: &'a str,
    tags: Vec<String>,
    b: Vec<usize>,
    e: Vec<usize>,
    t: Vec<usize>,
    s: Vec<i64>,
    bs: Vec<i64>,
    line_max: usize,
    blk: i64,
    line: usize,
    parent: Parent,
    level: usize,
    list_indent: i64,
    out: Vec<Found>,
}

impl<'a> State<'a> {
    fn new(src: &'a str, tags: Vec<String>) -> Self {
        let bytes = src.as_bytes();
        let n = bytes.len();
        let (mut b, mut e, mut t, mut s, mut bs) = (vec![], vec![], vec![], vec![], vec![]);
        let (mut start, mut pos, mut indent, mut offset, mut found) = (0, 0, 0, 0i64, false);
        while pos < n {
            let ch = bytes[pos];
            if !found {
                if space(ch) {
                    indent += 1;
                    offset += if ch == b'\t' { 4 - offset % 4 } else { 1 };
                    pos += 1;
                    continue;
                }
                found = true;
            }
            if ch == b'\n' || pos == n - 1 {
                if ch != b'\n' {
                    pos += 1;
                }
                b.push(start);
                e.push(pos);
                t.push(indent);
                s.push(offset);
                bs.push(0);
                found = false;
                indent = 0;
                offset = 0;
                start = pos + 1;
            }
            pos += 1;
        }
        b.push(n);
        e.push(n);
        t.push(0);
        s.push(0);
        bs.push(0);
        let line_max = b.len() - 1;
        State {
            src,
            tags,
            b,
            e,
            t,
            s,
            bs,
            line_max,
            blk: 0,
            line: 0,
            parent: Parent::Root,
            level: 0,
            list_indent: -1,
            out: Vec::new(),
        }
    }

    /// `charCodeAt`: 0 past the end, which equals no marker.
    fn at(&self, pos: usize) -> u8 {
        self.src.as_bytes().get(pos).copied().unwrap_or(0)
    }

    fn empty(&self, line: usize) -> bool {
        self.b[line] + self.t[line] >= self.e[line]
    }

    fn skip_empty(&self, mut line: usize) -> usize {
        while line < self.line_max && self.b[line] + self.t[line] >= self.e[line] {
            line += 1;
        }
        line
    }

    fn skip_spaces(&self, mut pos: usize) -> usize {
        while pos < self.src.len() && space(self.at(pos)) {
            pos += 1;
        }
        pos
    }

    fn skip_chars(&self, mut pos: usize, ch: u8) -> usize {
        while pos < self.src.len() && self.at(pos) == ch {
            pos += 1;
        }
        pos
    }

    fn text(&self, line: usize) -> &'a str {
        &self.src[self.b[line] + self.t[line]..self.e[line]]
    }

    /// The insert tag a line would open if it started a block.
    fn looks_like_insert(&self, line: usize) -> Option<String> {
        let text = self.text(line).trim_start_matches(js_space);
        self.tags
            .iter()
            .find(|tag| {
                text.strip_prefix('<')
                    .is_some_and(|t| t.starts_with(tag.as_str()))
            })
            .cloned()
    }

    fn mark_continued(&mut self, first: usize, end: usize) {
        for line in first..end {
            if let Some(tag) = self.looks_like_insert(line) {
                self.out.push(Found::Continued { tag, line });
            }
        }
    }

    fn terminates(&mut self, rules: &[Rule], line: usize, end: usize) -> bool {
        rules.iter().any(|&rule| self.run(rule, line, end, true))
    }

    fn run(&mut self, rule: Rule, start: usize, end: usize, silent: bool) -> bool {
        match rule {
            Rule::Table => self.table(start, end, silent),
            Rule::Code => self.code(start, end),
            Rule::Fence => self.fence(start, end, silent),
            Rule::Blockquote => self.blockquote(start, end, silent),
            Rule::Hr => self.hr(start, silent),
            Rule::List => self.list(start, end, silent),
            Rule::Reference => self.reference(start, silent),
            Rule::Card(i) => self.card(i, start, end, silent),
            Rule::HtmlBlock => self.html_block(start, end, silent),
            Rule::Heading => self.heading(start, silent),
            Rule::Lheading => self.lheading(start, end),
            Rule::Paragraph => self.paragraph(start, end),
        }
    }

    /// ParserBlock.tokenize.
    fn tokenize(&mut self, start: usize, end: usize) {
        let mut rules = vec![
            Rule::Table,
            Rule::Code,
            Rule::Fence,
            Rule::Blockquote,
            Rule::Hr,
            Rule::List,
            Rule::Reference,
        ];
        rules.extend((0..self.tags.len()).map(Rule::Card));
        rules.extend([
            Rule::HtmlBlock,
            Rule::Heading,
            Rule::Lheading,
            Rule::Paragraph,
        ]);
        let mut line = start;
        while line < end {
            line = self.skip_empty(line);
            self.line = line;
            if line >= end || self.s[line] < self.blk {
                break;
            }
            if self.level >= MAX_NESTING {
                self.line = end;
                break;
            }
            for &rule in &rules {
                if self.run(rule, line, end, false) {
                    break;
                }
            }
            line = self.line;
            if line < end && self.empty(line) {
                line += 1;
                self.line = line;
            }
        }
    }

    fn table(&mut self, start: usize, end: usize, silent: bool) -> bool {
        if start + 2 > end {
            return false;
        }
        let next = start + 1;
        if self.s[next] < self.blk || self.s[next] - self.blk >= 4 {
            return false;
        }
        let mut pos = self.b[next] + self.t[next];
        if pos >= self.e[next] {
            return false;
        }
        let first = self.at(pos);
        pos += 1;
        if !matches!(first, b'|' | b'-' | b':') || pos >= self.e[next] {
            return false;
        }
        let second = self.at(pos);
        pos += 1;
        if (!matches!(second, b'|' | b'-' | b':') && !space(second))
            || (first == b'-' && space(second))
        {
            return false;
        }
        while pos < self.e[next] {
            let ch = self.at(pos);
            if !matches!(ch, b'|' | b'-' | b':') && !space(ch) {
                return false;
            }
            pos += 1;
        }
        let cells: Vec<&str> = self.text(next).split('|').collect();
        let mut columns = 0i64;
        for (i, cell) in cells.iter().enumerate() {
            let cell = js_trim(cell);
            if cell.is_empty() {
                if i == 0 || i == cells.len() - 1 {
                    continue;
                }
                return false;
            }
            let inner = cell.strip_prefix(':').unwrap_or(cell);
            let inner = inner.strip_suffix(':').unwrap_or(inner);
            if inner.is_empty() || !inner.bytes().all(|c| c == b'-') {
                return false;
            }
            columns += 1;
        }
        let header = js_trim(self.text(start));
        if !header.contains('|') || self.s[start] - self.blk >= 4 {
            return false;
        }
        let count = row_cells(header);
        if count == 0 || count != columns {
            return false;
        }
        if silent {
            return true;
        }
        let old_parent = self.parent;
        self.parent = Parent::Table;
        self.mark_continued(start, start + 1);
        let mut autocompleted = 0i64;
        let mut next = start + 2;
        while next < end && self.s[next] >= self.blk {
            if self.terminates(BLOCKQUOTE_TERMS, next, end) {
                break;
            }
            let row = js_trim(self.text(next));
            if row.is_empty() || self.s[next] - self.blk >= 4 {
                break;
            }
            autocompleted += columns - row_cells(row);
            if autocompleted > MAX_AUTOCOMPLETED_CELLS {
                break;
            }
            self.mark_continued(next, next + 1);
            next += 1;
        }
        self.parent = old_parent;
        self.line = next;
        true
    }

    fn code(&mut self, start: usize, end: usize) -> bool {
        if self.s[start] - self.blk < 4 {
            return false;
        }
        let mut next = start + 1;
        let mut last = next;
        while next < end {
            if self.empty(next) {
                next += 1;
                continue;
            }
            if self.s[next] - self.blk >= 4 {
                next += 1;
                last = next;
                continue;
            }
            break;
        }
        self.line = last;
        true
    }

    fn fence(&mut self, start: usize, end: usize, silent: bool) -> bool {
        let mut pos = self.b[start] + self.t[start];
        let mut max = self.e[start];
        if self.s[start] - self.blk >= 4 || pos + 3 > max {
            return false;
        }
        let marker = self.at(pos);
        if marker != b'~' && marker != b'`' {
            return false;
        }
        let mut mem = pos;
        pos = self.skip_chars(pos, marker);
        let len = pos - mem;
        if len < 3 {
            return false;
        }
        if marker == b'`' && self.src[pos..max].contains('`') {
            return false;
        }
        if silent {
            return true;
        }
        let mut next = start;
        let mut closed = false;
        loop {
            next += 1;
            if next >= end {
                break;
            }
            pos = self.b[next] + self.t[next];
            mem = pos;
            max = self.e[next];
            if pos < max && self.s[next] < self.blk {
                break;
            }
            if self.at(pos) != marker || self.s[next] - self.blk >= 4 {
                continue;
            }
            pos = self.skip_chars(pos, marker);
            if pos - mem < len {
                continue;
            }
            pos = self.skip_spaces(pos);
            if pos < max {
                continue;
            }
            closed = true;
            break;
        }
        self.line = next + usize::from(closed);
        true
    }

    fn blockquote(&mut self, start: usize, end: usize, silent: bool) -> bool {
        let old_line_max = self.line_max;
        if self.s[start] - self.blk >= 4 || self.at(self.b[start] + self.t[start]) != b'>' {
            return false;
        }
        if silent {
            return true;
        }
        let (mut old_b, mut old_bs, mut old_s, mut old_t) = (vec![], vec![], vec![], vec![]);
        let old_parent = self.parent;
        self.parent = Parent::Blockquote;
        let mut last_empty = false;
        let mut next = start;
        while next < end {
            let outdented = self.s[next] < self.blk;
            let mut pos = self.b[next] + self.t[next];
            let max = self.e[next];
            if pos >= max {
                break;
            }
            if self.at(pos) == b'>' && !outdented {
                pos += 1;
                let mut initial = self.s[next] + 1;
                let (space_after, adjust_tab);
                if self.at(pos) == b' ' {
                    pos += 1;
                    initial += 1;
                    adjust_tab = false;
                    space_after = true;
                } else if self.at(pos) == b'\t' {
                    space_after = true;
                    if (self.bs[next] + initial) % 4 == 3 {
                        pos += 1;
                        initial += 1;
                        adjust_tab = false;
                    } else {
                        adjust_tab = true;
                    }
                } else {
                    space_after = false;
                    adjust_tab = false;
                }
                let mut offset = initial;
                old_b.push(self.b[next]);
                self.b[next] = pos;
                while pos < max {
                    match self.at(pos) {
                        b'\t' => offset += 4 - (offset + self.bs[next] + i64::from(adjust_tab)) % 4,
                        b' ' => offset += 1,
                        _ => break,
                    }
                    pos += 1;
                }
                last_empty = pos >= max;
                old_bs.push(self.bs[next]);
                self.bs[next] = self.s[next] + 1 + i64::from(space_after);
                old_s.push(self.s[next]);
                self.s[next] = offset - initial;
                old_t.push(self.t[next]);
                self.t[next] = pos - self.b[next];
                next += 1;
                continue;
            }
            if last_empty {
                break;
            }
            if self.terminates(BLOCKQUOTE_TERMS, next, end) {
                self.line_max = next;
                if self.blk != 0 {
                    old_b.push(self.b[next]);
                    old_bs.push(self.bs[next]);
                    old_t.push(self.t[next]);
                    old_s.push(self.s[next]);
                    self.s[next] -= self.blk;
                }
                break;
            }
            old_b.push(self.b[next]);
            old_bs.push(self.bs[next]);
            old_t.push(self.t[next]);
            old_s.push(self.s[next]);
            self.s[next] = -1;
            next += 1;
        }
        let old_indent = self.blk;
        self.blk = 0;
        self.level += 1;
        self.tokenize(start, next);
        self.level -= 1;
        self.line_max = old_line_max;
        self.parent = old_parent;
        for i in 0..old_t.len() {
            self.b[i + start] = old_b[i];
            self.t[i + start] = old_t[i];
            self.s[i + start] = old_s[i];
            self.bs[i + start] = old_bs[i];
        }
        self.blk = old_indent;
        true
    }

    fn hr(&mut self, start: usize, silent: bool) -> bool {
        let max = self.e[start];
        if self.s[start] - self.blk >= 4 {
            return false;
        }
        let mut pos = self.b[start] + self.t[start];
        let marker = self.at(pos);
        pos += 1;
        if !matches!(marker, b'*' | b'-' | b'_') {
            return false;
        }
        let mut count = 1;
        while pos < max {
            let ch = self.at(pos);
            pos += 1;
            if ch != marker && !space(ch) {
                return false;
            }
            if ch == marker {
                count += 1;
            }
        }
        if count < 3 {
            return false;
        }
        if !silent {
            self.line = start + 1;
        }
        true
    }

    /// After a bullet marker, or None.
    fn bullet(&self, line: usize) -> Option<usize> {
        let max = self.e[line];
        let mut pos = self.b[line] + self.t[line];
        let marker = self.at(pos);
        pos += 1;
        if !matches!(marker, b'*' | b'-' | b'+') {
            return None;
        }
        if pos < max && !space(self.at(pos)) {
            return None;
        }
        Some(pos)
    }

    /// After an ordered-list marker, or None.
    fn ordered(&self, line: usize) -> Option<usize> {
        let start = self.b[line] + self.t[line];
        let max = self.e[line];
        let mut pos = start;
        if pos + 1 >= max {
            return None;
        }
        let ch = self.at(pos);
        pos += 1;
        if !ch.is_ascii_digit() {
            return None;
        }
        loop {
            if pos >= max {
                return None;
            }
            let ch = self.at(pos);
            pos += 1;
            if ch.is_ascii_digit() {
                if pos - start >= 10 {
                    return None;
                }
                continue;
            }
            if ch == b')' || ch == b'.' {
                break;
            }
            return None;
        }
        if pos < max && !space(self.at(pos)) {
            return None;
        }
        Some(pos)
    }

    fn list(&mut self, start: usize, end: usize, silent: bool) -> bool {
        let mut line = start;
        if self.s[line] - self.blk >= 4 {
            return false;
        }
        if self.list_indent >= 0 && self.s[line] - self.list_indent >= 4 && self.s[line] < self.blk
        {
            return false;
        }
        let interrupts = silent && self.parent == Parent::Paragraph && self.s[line] >= self.blk;
        let ordered;
        let mut after = match self.ordered(line) {
            Some(after) => {
                ordered = true;
                let marker_start = self.b[line] + self.t[line];
                if interrupts && self.src[marker_start..after - 1] != *"1" {
                    // Number("01") is 1 as well.
                    let digits = self.src[marker_start..after - 1].trim_start_matches('0');
                    if digits != "1" {
                        return false;
                    }
                }
                after
            }
            None => match self.bullet(line) {
                Some(after) => {
                    ordered = false;
                    after
                }
                None => return false,
            },
        };
        if interrupts && self.skip_spaces(after) >= self.e[line] {
            return false;
        }
        if silent {
            return true;
        }
        let marker = self.at(after - 1);
        let old_parent = self.parent;
        self.parent = Parent::List;
        self.level += 1;
        while line < end {
            let mut pos = after;
            let max = self.e[line];
            let initial = self.s[line] + (after - (self.b[line] + self.t[line])) as i64;
            let mut offset = initial;
            while pos < max {
                match self.at(pos) {
                    b'\t' => offset += 4 - (offset + self.bs[line]) % 4,
                    b' ' => offset += 1,
                    _ => break,
                }
                pos += 1;
            }
            let content_start = pos;
            let mut indent_after = if content_start >= max {
                1
            } else {
                offset - initial
            };
            if indent_after > 4 {
                indent_after = 1;
            }
            let indent = initial + indent_after;
            let (old_t, old_s, old_list_indent) = (self.t[line], self.s[line], self.list_indent);
            self.list_indent = self.blk;
            self.blk = indent;
            self.t[line] = content_start - self.b[line];
            self.s[line] = offset;
            self.level += 1;
            if content_start >= max && self.empty(line + 1) {
                self.line = (self.line + 2).min(end);
            } else {
                self.tokenize(line, end);
            }
            self.level -= 1;
            self.blk = self.list_indent;
            self.list_indent = old_list_indent;
            self.t[line] = old_t;
            self.s[line] = old_s;
            line = self.line;
            if line >= end || self.s[line] < self.blk || self.s[line] - self.blk >= 4 {
                break;
            }
            if self.terminates(LIST_TERMS, line, end) {
                break;
            }
            let next = if ordered {
                self.ordered(line)
            } else {
                self.bullet(line)
            };
            match next {
                Some(next) => after = next,
                None => break,
            }
            if marker != self.at(after - 1) {
                break;
            }
        }
        self.level -= 1;
        self.line = line;
        self.parent = old_parent;
        true
    }

    /// A line a link reference definition may continue onto, or None.
    fn ref_continuation(&mut self, line: usize) -> Option<String> {
        let line_max = self.line_max;
        if line >= line_max || self.empty(line) {
            return None;
        }
        let lazy = self.s[line] - self.blk > 3 || self.s[line] < 0;
        if !lazy {
            let old_parent = self.parent;
            self.parent = Parent::Reference;
            let stop = self.terminates(PARAGRAPH_TERMS, line, line_max);
            self.parent = old_parent;
            if stop {
                return None;
            }
        }
        let to = (self.e[line] + 1).min(self.src.len());
        Some(self.src[self.b[line] + self.t[line]..to].to_string())
    }

    fn reference(&mut self, start: usize, silent: bool) -> bool {
        let pos = self.b[start] + self.t[start];
        let max = self.e[start];
        let mut next = start + 1;
        if self.s[start] - self.blk >= 4 || self.at(pos) != b'[' {
            return false;
        }
        let mut text = self.src[pos..(max + 1).min(self.src.len())].to_string();
        macro_rules! more {
            () => {
                if let Some(more) = self.ref_continuation(next) {
                    text.push_str(&more);
                    next += 1;
                }
            };
        }
        let mut label_end = None;
        let mut i = 1;
        while i < text.len() {
            match text.as_bytes()[i] {
                b'[' => return false,
                b']' => {
                    label_end = Some(i);
                    break;
                }
                b'\n' => more!(),
                b'\\' => {
                    i += 1;
                    if text.as_bytes().get(i) == Some(&b'\n') {
                        more!();
                    }
                }
                _ => {}
            }
            i += 1;
        }
        let Some(label_end) = label_end else {
            return false;
        };
        if text.as_bytes().get(label_end + 1) != Some(&b':') {
            return false;
        }
        i = label_end + 2;
        while i < text.len() {
            match text.as_bytes()[i] {
                b'\n' => more!(),
                c if space(c) => {}
                _ => break,
            }
            i += 1;
        }
        let Some((dest, after)) = link_destination(&text, i) else {
            return false;
        };
        if !valid_link(&dest) {
            return false;
        }
        i = after;
        let (dest_end, dest_next, before_title) = (i, next, i);
        while i < text.len() {
            match text.as_bytes()[i] {
                b'\n' => more!(),
                c if space(c) => {}
                _ => break,
            }
            i += 1;
        }
        let mut title = link_title(&text, i, None);
        while title.can_continue {
            let Some(more) = self.ref_continuation(next) else {
                break;
            };
            i = text.len();
            text.push_str(&more);
            next += 1;
            title = link_title(&text, i, Some(&title));
        }
        let mut has_title;
        if i < text.len() && before_title != i && title.ok {
            has_title = !title.text.is_empty();
            i = title.pos;
        } else {
            has_title = false;
            i = dest_end;
            next = dest_next;
        }
        let bytes = text.as_bytes();
        while i < bytes.len() && space(bytes[i]) {
            i += 1;
        }
        if i < bytes.len() && bytes[i] != b'\n' && has_title {
            has_title = false;
            i = dest_end;
            next = dest_next;
            while i < bytes.len() && space(bytes[i]) {
                i += 1;
            }
        }
        let _ = has_title;
        if i < bytes.len() && bytes[i] != b'\n' {
            return false;
        }
        if js_trim(&text[1..label_end]).is_empty() {
            return false;
        }
        if !silent {
            self.mark_continued(start + 1, next);
            self.line = next;
        }
        true
    }

    fn card(&mut self, index: usize, start: usize, end: usize, silent: bool) -> bool {
        let tag = self.tags[index].clone();
        let text = self.text(start);
        if !js_trim(text)
            .strip_prefix('<')
            .is_some_and(|t| t.starts_with(&tag))
        {
            return false;
        }
        if silent {
            return true;
        }
        let closing = format!("</{tag}>");
        if text.contains(&closing) {
            self.out.push(Found::Card {
                tag,
                line: start,
                content: text.to_string(),
                end: start + 1,
                closed: true,
            });
            self.line = start + 1;
            return true;
        }
        let mut next = start + 1;
        let mut content = text.to_string();
        let mut closed = false;
        while next < end {
            let line = self.text(next);
            content.push('\n');
            content.push_str(line);
            next += 1;
            if line.contains(&closing) {
                closed = true;
                break;
            }
        }
        self.out.push(Found::Card {
            tag,
            line: start,
            content,
            end: next,
            closed,
        });
        self.line = next;
        true
    }

    fn html_block(&mut self, start: usize, end: usize, silent: bool) -> bool {
        if self.s[start] - self.blk >= 4 {
            return false;
        }
        let text = self.text(start);
        if !text.starts_with('<') {
            return false;
        }
        let Some(kind) = html_sequence(text) else {
            return false;
        };
        if silent {
            return kind != HtmlKind::LoneTag;
        }
        let mut next = start + 1;
        if !kind.closes(text) {
            while next < end && self.s[next] >= self.blk {
                let line = self.text(next);
                if kind.closes(line) {
                    if !line.is_empty() {
                        next += 1;
                    }
                    break;
                }
                next += 1;
            }
        }
        self.out.push(Found::HtmlBlock { line: start });
        self.line = next;
        true
    }

    fn heading(&mut self, start: usize, silent: bool) -> bool {
        let mut pos = self.b[start] + self.t[start];
        let max = self.e[start];
        if self.s[start] - self.blk >= 4 || self.at(pos) != b'#' || pos >= max {
            return false;
        }
        let mut level = 1;
        pos += 1;
        let mut ch = self.at(pos);
        while ch == b'#' && pos < max && level <= 6 {
            level += 1;
            pos += 1;
            ch = self.at(pos);
        }
        if level > 6 || (pos < max && !space(ch)) {
            return false;
        }
        if !silent {
            self.line = start + 1;
        }
        true
    }

    fn lheading(&mut self, start: usize, end: usize) -> bool {
        if self.s[start] - self.blk >= 4 {
            return false;
        }
        let old_parent = self.parent;
        self.parent = Parent::Paragraph;
        let mut level = 0;
        let mut next = start + 1;
        while next < end && !self.empty(next) {
            if self.s[next] - self.blk > 3 {
                next += 1;
                continue;
            }
            if self.s[next] >= self.blk {
                let mut pos = self.b[next] + self.t[next];
                let max = self.e[next];
                if pos < max {
                    let marker = self.at(pos);
                    if marker == b'-' || marker == b'=' {
                        pos = self.skip_spaces(self.skip_chars(pos, marker));
                        if pos >= max {
                            level = if marker == b'=' { 1 } else { 2 };
                            break;
                        }
                    }
                }
            }
            if self.s[next] < 0 {
                next += 1;
                continue;
            }
            if self.terminates(PARAGRAPH_TERMS, next, end) {
                break;
            }
            next += 1;
        }
        if level == 0 {
            // markdown-it 14.1.0 leaves parentType as "paragraph" here.
            return false;
        }
        self.mark_continued(start + 1, next);
        self.line = next + 1;
        self.parent = old_parent;
        true
    }

    fn paragraph(&mut self, start: usize, end: usize) -> bool {
        let old_parent = self.parent;
        let mut next = start + 1;
        self.parent = Parent::Paragraph;
        while next < end && !self.empty(next) {
            if self.s[next] - self.blk > 3 || self.s[next] < 0 {
                next += 1;
                continue;
            }
            if self.terminates(PARAGRAPH_TERMS, next, end) {
                break;
            }
            next += 1;
        }
        self.mark_continued(start + 1, next);
        self.line = next;
        self.parent = old_parent;
        true
    }
}

/// markdown-it's escapedSplit, less its empty first and last cells: the count.
fn row_cells(row: &str) -> i64 {
    let bytes = row.as_bytes();
    let mut cells: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut last = 0;
    let mut escaped = false;
    for (i, &ch) in bytes.iter().enumerate() {
        if ch == b'|' {
            if escaped {
                current.push_str(&row[last..i - 1]);
                last = i;
            } else {
                cells.push(format!("{current}{}", &row[last..i]));
                current.clear();
                last = i + 1;
            }
        }
        escaped = ch == b'\\';
    }
    cells.push(format!("{current}{}", &row[last..]));
    let mut count = cells.len() as i64;
    if cells.first().is_some_and(String::is_empty) {
        count -= 1;
    }
    if count > 0 && cells.last().is_some_and(String::is_empty) {
        count -= 1;
    }
    count
}

fn link_destination(text: &str, mut pos: usize) -> Option<(String, usize)> {
    let bytes = text.as_bytes();
    let end = bytes.len();
    let start = pos;
    if bytes.get(pos) == Some(&b'<') {
        pos += 1;
        while pos < end {
            match bytes[pos] {
                b'\n' | b'<' => return None,
                b'>' => return Some((unescape(&text[start + 1..pos]), pos + 1)),
                b'\\' if pos + 1 < end => pos += 2,
                _ => pos += 1,
            }
        }
        return None;
    }
    let mut depth = 0;
    while pos < end {
        let ch = bytes[pos];
        if ch == b' ' || ch < 0x20 || ch == 0x7f {
            break;
        }
        if ch == b'\\' && pos + 1 < end {
            if bytes[pos + 1] == b' ' {
                break;
            }
            pos += 2;
            continue;
        }
        if ch == b'(' {
            depth += 1;
            if depth > 32 {
                return None;
            }
        }
        if ch == b')' {
            if depth == 0 {
                break;
            }
            depth -= 1;
        }
        pos += 1;
    }
    if start == pos || depth != 0 {
        return None;
    }
    // A backslash before a multi-byte character can leave `pos` inside it;
    // markdown-it then stops only at an ASCII byte or the end, as here.
    Some((unescape(text.get(start..pos)?), pos))
}

struct Title {
    ok: bool,
    can_continue: bool,
    pos: usize,
    text: String,
    marker: u8,
}

fn link_title(text: &str, mut pos: usize, prev: Option<&Title>) -> Title {
    let bytes = text.as_bytes();
    let end = bytes.len();
    let mut out = Title {
        ok: false,
        can_continue: false,
        pos: 0,
        text: String::new(),
        marker: 0,
    };
    let mut start = pos;
    match prev {
        Some(prev) => {
            out.text = prev.text.clone();
            out.marker = prev.marker;
        }
        None => {
            let Some(&ch) = bytes.get(pos) else {
                return out;
            };
            if !matches!(ch, b'"' | b'\'' | b'(') {
                return out;
            }
            start += 1;
            pos += 1;
            out.marker = if ch == b'(' { b')' } else { ch };
        }
    }
    while pos < end {
        let ch = bytes[pos];
        if ch == out.marker {
            out.pos = pos + 1;
            out.text
                .push_str(&unescape(text.get(start..pos).unwrap_or_default()));
            out.ok = true;
            return out;
        }
        if ch == b'(' && out.marker == b')' {
            return out;
        }
        if ch == b'\\' && pos + 1 < end {
            pos += 1;
        }
        pos += 1;
    }
    out.can_continue = true;
    out.text
        .push_str(&unescape(text.get(start..).unwrap_or_default()));
    out
}

/// Backslash escapes and the character references that matter to
/// validateLink (numeric ones and the five XML names).
fn unescape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(c) = rest.chars().next() {
        if c == '\\' {
            if let Some(p) = rest[1..]
                .chars()
                .next()
                .filter(|p| p.is_ascii_punctuation())
            {
                out.push(p);
                rest = &rest[2..];
                continue;
            }
        }
        if c == '&' {
            if let Some((ch, len)) = reference(rest) {
                out.push_str(&ch);
                rest = &rest[len..];
                continue;
            }
        }
        out.push(c);
        rest = &rest[c.len_utf8()..];
    }
    out
}

/// `&#x…;`, `&#…;` or one of the five XML names, at the start of `text`.
fn reference(text: &str) -> Option<(String, usize)> {
    let body = &text[1..];
    let semi = body.find(';')?;
    let name = &body[..semi];
    let len = semi + 2;
    let named = match name {
        "amp" => Some("&"),
        "lt" => Some("<"),
        "gt" => Some(">"),
        "quot" => Some("\""),
        "apos" => Some("'"),
        _ => None,
    };
    if let Some(s) = named {
        return Some((s.to_string(), len));
    }
    let num = name.strip_prefix('#')?;
    let code = match num.strip_prefix(['x', 'X']) {
        Some(hex) if (1..=6).contains(&hex.len()) && hex.bytes().all(|c| c.is_ascii_hexdigit()) => {
            u32::from_str_radix(hex, 16).ok()?
        }
        None if (1..=7).contains(&num.len()) && num.bytes().all(|c| c.is_ascii_digit()) => {
            num.parse().ok()?
        }
        _ => return None,
    };
    let valid = code > 0 && char::from_u32(code).is_some();
    Some((
        if valid {
            char::from_u32(code)?.to_string()
        } else {
            format!("&{name};")
        },
        len,
    ))
}

/// markdown-it's validateLink (after normalizeLink, which keeps the scheme).
fn valid_link(url: &str) -> bool {
    let lowered = js_trim(url).to_lowercase();
    let bad = ["vbscript:", "javascript:", "file:", "data:"]
        .iter()
        .any(|p| lowered.starts_with(p));
    !bad || ["gif", "png", "jpeg", "webp"]
        .iter()
        .any(|f| lowered.starts_with(&format!("data:image/{f};")))
}

#[derive(Clone, Copy, PartialEq)]
enum HtmlKind {
    /// script, pre, style or textarea: ends at any of their closing tags.
    Raw,
    Comment,
    Processing,
    Declaration,
    Cdata,
    /// A CommonMark block tag name: ends at a blank line.
    BlockName,
    /// A whole-line open or close tag: ends at a blank line and cannot
    /// interrupt a paragraph.
    LoneTag,
}

impl HtmlKind {
    fn closes(self, line: &str) -> bool {
        match self {
            HtmlKind::Raw => {
                let lowered = line.to_ascii_lowercase();
                ["</script>", "</pre>", "</style>", "</textarea>"]
                    .iter()
                    .any(|c| lowered.contains(c))
            }
            HtmlKind::Comment => line.contains("-->"),
            HtmlKind::Processing => line.contains("?>"),
            HtmlKind::Declaration => line.contains('>'),
            HtmlKind::Cdata => line.contains("]]>"),
            HtmlKind::BlockName | HtmlKind::LoneTag => line.is_empty(),
        }
    }
}

const BLOCK_NAMES: &[&str] = &[
    "address",
    "article",
    "aside",
    "base",
    "basefont",
    "blockquote",
    "body",
    "caption",
    "center",
    "col",
    "colgroup",
    "dd",
    "details",
    "dialog",
    "dir",
    "div",
    "dl",
    "dt",
    "fieldset",
    "figcaption",
    "figure",
    "footer",
    "form",
    "frame",
    "frameset",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "head",
    "header",
    "hr",
    "html",
    "iframe",
    "legend",
    "li",
    "link",
    "main",
    "menu",
    "menuitem",
    "nav",
    "noframes",
    "ol",
    "optgroup",
    "option",
    "p",
    "param",
    "search",
    "section",
    "summary",
    "table",
    "tbody",
    "td",
    "tfoot",
    "th",
    "thead",
    "title",
    "tr",
    "track",
    "ul",
];

/// Which of markdown-it 14.1.0's HTML_SEQUENCES opens at `text` (a line
/// starting with `<`), tried in order.
fn html_sequence(text: &str) -> Option<HtmlKind> {
    let rest = &text[1..];
    let lowered = rest.to_ascii_lowercase();
    let ends_name = |after: &str, slash_gt: bool| -> bool {
        match after.chars().next() {
            None => true,
            Some(c) if js_space(c) || c == '>' => true,
            Some('/') => slash_gt && after[1..].starts_with('>'),
            _ => false,
        }
    };
    if ["script", "pre", "style", "textarea"]
        .iter()
        .any(|n| lowered.starts_with(n) && ends_name(&rest[n.len()..], false))
    {
        return Some(HtmlKind::Raw);
    }
    if rest.starts_with("!--") {
        return Some(HtmlKind::Comment);
    }
    if rest.starts_with('?') {
        return Some(HtmlKind::Processing);
    }
    if rest.starts_with('!') && rest.as_bytes().get(1).is_some_and(u8::is_ascii_uppercase) {
        return Some(HtmlKind::Declaration);
    }
    if rest.starts_with("![CDATA[") {
        return Some(HtmlKind::Cdata);
    }
    let (named, offset) = match lowered.strip_prefix('/') {
        Some(n) => (n, 1),
        None => (lowered.as_str(), 0),
    };
    if BLOCK_NAMES
        .iter()
        .any(|n| named.starts_with(n) && ends_name(&rest[offset + n.len()..], true))
    {
        return Some(HtmlKind::BlockName);
    }
    let end = open_tag(text).or_else(|| close_tag(text))?;
    text[end..]
        .chars()
        .all(js_space)
        .then_some(HtmlKind::LoneTag)
}

/// Skip ECMAScript whitespace from `pos`.
fn skip_js_space(text: &str, mut pos: usize) -> usize {
    while let Some(c) = text[pos..].chars().next().filter(|&c| js_space(c)) {
        pos += c.len_utf8();
    }
    pos
}

fn tag_name(text: &str, pos: usize) -> Option<usize> {
    let bytes = text.as_bytes();
    if !bytes.get(pos)?.is_ascii_alphabetic() {
        return None;
    }
    let mut i = pos + 1;
    while bytes
        .get(i)
        .is_some_and(|c| c.is_ascii_alphanumeric() || *c == b'-')
    {
        i += 1;
    }
    Some(i)
}

/// markdown-it's `open_tag` at the start of `text`: the end of the match.
fn open_tag(text: &str) -> Option<usize> {
    let bytes = text.as_bytes();
    let mut i = tag_name(text, 1)?;
    loop {
        let after_space = skip_js_space(text, i);
        if after_space == i
            || !bytes
                .get(after_space)
                .is_some_and(|c| c.is_ascii_alphabetic() || *c == b'_' || *c == b':')
        {
            break;
        }
        let mut j = after_space + 1;
        while bytes
            .get(j)
            .is_some_and(|c| c.is_ascii_alphanumeric() || matches!(c, b':' | b'.' | b'_' | b'-'))
        {
            j += 1;
        }
        i = j;
        let eq = skip_js_space(text, j);
        if bytes.get(eq) == Some(&b'=') {
            let v = skip_js_space(text, eq + 1);
            if let Some(after) = attr_value(text, v) {
                i = after;
            }
        }
    }
    let mut i = skip_js_space(text, i);
    if bytes.get(i) == Some(&b'/') {
        i += 1;
    }
    (bytes.get(i) == Some(&b'>')).then_some(i + 1)
}

fn attr_value(text: &str, pos: usize) -> Option<usize> {
    let bytes = text.as_bytes();
    match *bytes.get(pos)? {
        q @ (b'"' | b'\'') => Some(pos + 1 + text[pos + 1..].find(q as char)? + 1),
        _ => {
            let mut i = pos;
            while bytes.get(i).is_some_and(|&c| {
                !matches!(c, b'"' | b'\'' | b'=' | b'<' | b'>' | b'`') && c > 0x20
            }) {
                i += 1;
            }
            (i > pos).then_some(i)
        }
    }
}

/// markdown-it's `close_tag` at the start of `text`: the end of the match.
fn close_tag(text: &str) -> Option<usize> {
    if !text.starts_with("</") {
        return None;
    }
    let i = skip_js_space(text, tag_name(text, 2)?);
    (text.as_bytes().get(i) == Some(&b'>')).then_some(i + 1)
}
