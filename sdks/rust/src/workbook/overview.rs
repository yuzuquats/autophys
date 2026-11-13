//! Project overviews (workbook format 3, OV-1 to OV-4): an append-only
//! history of one Markdown research note per project, independent of the
//! records, config hashes and display. `verify` and `rebuild_projections`
//! ignore it, as they ignore display.
//!
//! Validation is advisory (OV-3): a write is refused only for an empty body,
//! a body over [`MAX_OVERVIEW_BYTES`] or a missing author. Everything else
//! comes back as [`OverviewWarning`]s from a canonical-form lint (OV-13), not
//! from a Markdown parser. An insert is accepted silently only when it is
//! written alone on one line at column 0, after a blank line or at the start
//! of the document, as `<ap-investigation …></ap-investigation>`, outside
//! fenced and indented code. Every other line that mentions the insert tag
//! outside code, and every line that may start an HTML block, gets a warning.
//! The lint over-warns on purpose: a document with no warnings renders one
//! card per canonical insert line, and no insert hides text. Text the viewer
//! drops for reasons unrelated to inserts (inline HTML, a hard break in a
//! setext heading, nesting past markdown-it's limit) is not checked. That
//! guarantee is what
//! `html/routes/overview-vectors.deno.test.ts` holds against the bundled
//! viewer. Canonical inserts are also checked for investigations the workbook
//! does not hold and attribute keys the viewer does not know, read from
//! `html/ui/investigation-inserts.json`. Python's `autophys.overview` has the
//! same rules and `tests/conformance/overview/cases.json` pins both.
use std::collections::BTreeSet;
use std::sync::OnceLock;

use super::*;

/// Largest overview body, in UTF-8 bytes (256 KiB).
pub const MAX_OVERVIEW_BYTES: usize = 256 * 1024;

/// Longest author, in characters (as a project name).
const MAX_AUTHOR_CHARS: usize = 200;

/// One stored overview version. `digest` is the bare sha256 hex of the
/// Markdown's UTF-8 bytes; `seq` orders the versions (latest = highest).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct StoredOverview {
    pub seq: i64,
    pub digest: String,
    pub markdown: String,
    pub author: String,
    pub created: f64,
}

/// The latest version's `seq` and `digest` without its Markdown: what a
/// poller compares before it reads the body ([`Workbook::overview_head`]).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct OverviewHead {
    pub seq: i64,
    pub digest: String,
}

/// An advisory finding about an overview write; the write still happened.
/// `code` is one of:
///
/// - `noncanonical_insert` (with `line` and `reason`): a line that mentions
///   an insert tag but is not a canonical insert, so the viewer may show no
///   card for it or hide text;
/// - `html_block` (with `line`): a line that may start an HTML block, which
///   stops the viewer displaying the whole overview;
/// - `unknown_investigation` (with `investigation`, empty when the insert
///   names none): a canonical insert the viewer shows as "Investigation
///   unavailable";
/// - `unknown_attribute` (with `attribute`): an attribute of a canonical
///   insert that the viewer ignores.
///
/// `line` is 1-based.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct OverviewWarning {
    pub code: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub investigation: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attribute: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

struct InsertSpec {
    tag: String,
    reference: String,
    attributes: Vec<String>,
}

#[derive(Deserialize)]
struct InsertFile {
    inserts: Vec<InsertJson>,
}

#[derive(Deserialize)]
struct InsertJson {
    tag: String,
    reference: String,
    attributes: Vec<String>,
}
/// The shared insert list; Python's copy is pinned byte-equal to this file.
pub(crate) const INSERTS_JSON: &str =
    include_str!("../../../../html/ui/investigation-inserts.json");

fn inserts() -> &'static [InsertSpec] {
    static SPECS: OnceLock<Vec<InsertSpec>> = OnceLock::new();
    SPECS.get_or_init(|| {
        let file: InsertFile =
            serde_json::from_str(INSERTS_JSON).expect("investigation-inserts.json");
        file.inserts
            .into_iter()
            .map(|i| InsertSpec {
                tag: i.tag,
                reference: i.reference,
                attributes: i.attributes,
            })
            .collect()
    })
}

/// Refuse what OV-3 refuses: an empty (or whitespace-only) or oversized body
/// and an author that is empty or longer than 200 characters.
pub(crate) fn check_write(markdown: &str, author: &str) -> Result<()> {
    if markdown.len() > MAX_OVERVIEW_BYTES {
        return Err(Error::TooLarge(MAX_OVERVIEW_BYTES));
    }
    if markdown.trim().is_empty() {
        return Err(Error::invalid("markdown", "required non-empty Markdown"));
    }
    if author.trim().is_empty() || author.chars().count() > MAX_AUTHOR_CHARS {
        return Err(Error::invalid(
            "author",
            "required string of 1 to 200 characters",
        ));
    }
    Ok(())
}

/// The advisory warnings for `markdown` in a workbook holding the
/// investigations `known` (OV-3, OV-13), in document order. Lines inside
/// fenced or indented code are skipped; attribute and investigation findings
/// come once each.
pub fn check_overview<S: AsRef<str>>(markdown: &str, known: &[S]) -> Vec<OverviewWarning> {
    lint(markdown, known).0
}

/// [`check_overview`]'s warnings and the 1-based lines of the canonical
/// inserts. When there are no warnings, the viewer shows exactly one card for
/// each of those lines and nothing else.
pub(crate) fn lint<S: AsRef<str>>(
    markdown: &str,
    known: &[S],
) -> (Vec<OverviewWarning>, Vec<usize>) {
    let known: BTreeSet<&str> = known.iter().map(AsRef::as_ref).collect();
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    let mut cards = Vec::new();
    let lines = lines(markdown);
    let mut states = BTreeSet::from([Reading::start()]);
    let mut lost = false;
    for (index, &line) in lines.iter().enumerate() {
        let number = index + 1;
        let readings: Vec<(Reading, bool)> = if lost {
            Vec::new()
        } else {
            states.iter().flat_map(|s| step(s, line)).collect()
        };
        if !readings.is_empty() && readings.iter().all(|(_, code)| *code) {
            states = readings.into_iter().map(|(s, _)| s).collect();
            continue;
        }
        let open_code = lost || readings.iter().any(|(_, code)| *code);
        let lower = line.to_ascii_lowercase();
        let mention = inserts().iter().find(|s| {
            lower.contains(&format!("<{}", s.tag)) || lower.contains(&format!("</{}", s.tag))
        });
        let mut canonical = false;
        if let Some(spec) = mention {
            let tag = &spec.tag;
            let prev_blank = index == 0 || blank(lines[index - 1]);
            let next_blank = lines.get(index + 1).is_none_or(|l| blank(l));
            match canonical_insert(line, &lower, tag, prev_blank, next_blank, open_code) {
                Ok(attrs) => {
                    canonical = true;
                    cards.push(number);
                    card_warnings(spec, &attrs, &known, &mut seen, &mut out);
                }
                Err(reason) => out.push(OverviewWarning {
                    code: "noncanonical_insert".into(),
                    message: format!(
                        "<{tag}> on line {number} is not in canonical form ({reason}), so the viewer may show no card or hide text; write each insert alone on one line at column 0 after a blank line, as <{tag} ...></{tag}>"
                    ),
                    investigation: None,
                    attribute: None,
                    line: Some(number),
                    reason: Some(reason),
                }),
            }
        } else if html_start(line) {
            out.push(OverviewWarning {
                code: "html_block".into(),
                message: format!(
                    "line {number} starts with an HTML tag; if the viewer reads it as an HTML block it shows \"The document could not be displayed\" instead of the overview, and an unclosed element can hide the lines after it"
                ),
                investigation: None,
                attribute: None,
                line: Some(number),
                reason: None,
            });
        }
        if lost {
            continue;
        }
        states = if canonical {
            BTreeSet::from([Reading::start()])
        } else {
            readings.into_iter().map(|(s, _)| s).collect()
        };
        if states.len() > MAX_READINGS {
            lost = true;
        }
    }
    (out, cards)
}

/// A canonical insert line's attributes, or why the line is not one.
fn canonical_insert(
    line: &str,
    lower: &str,
    tag: &str,
    prev_blank: bool,
    next_blank: bool,
    open_code: bool,
) -> std::result::Result<Attributes, String> {
    let start = format!("<{tag}");
    let close = format!("</{tag}>");
    if lower.matches(&start).count() > 1 || lower.matches(&format!("</{tag}")).count() > 1 {
        return Err("more than one insert tag on the line".into());
    }
    if !line.starts_with(&start) {
        return Err(if lower.starts_with(&start) {
            "the tag is not lowercase".into()
        } else if lower.contains(&start) {
            "it does not start at column 0".into()
        } else {
            "a closing tag without its start tag on the line".into()
        });
    }
    if line[start.len()..]
        .chars()
        .next()
        .is_some_and(|c| !matches!(c, ' ' | '\t' | '>'))
    {
        return Err(format!("the tag name continues past {tag}"));
    }
    let Some((_, attrs, end)) = start_tag(line, 1) else {
        return Err("the start tag is not closed on the line".into());
    };
    let rest = &line[end..];
    let Some(after) = rest.strip_prefix(&close) else {
        return Err(if rest.contains(&close) {
            format!("text between the start tag and {close}")
        } else {
            format!("no {close} on the same line")
        });
    };
    if !after.trim_matches([' ', '\t']).is_empty() {
        return Err(format!("text after {close}"));
    }
    if line.contains('|') && !next_blank {
        return Err(
            "a | in the line with a non-blank next line could make it a table header".into(),
        );
    }
    if !prev_blank {
        return Err("it does not follow a blank line".into());
    }
    if open_code {
        return Err("a code block opened earlier may still be open".into());
    }
    Ok(attrs)
}

// Where code may be open. Not a Markdown parser: an over-approximation of
// CommonMark's fences, indented code and list items, enough to skip lines
// that are certainly code and to know that a canonical line is certainly not.
// Where a line has two readings both are kept; a line is code only when
// every reading says so. Python's `_step` and `_plain` are the same rules.

const MAX_READINGS: usize = 64;

/// One reading of the document so far.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct Reading {
    /// 0 none, 1 a top-level fence, 2 a fence in the list item whose
    /// content starts at `column`.
    fence: u8,
    marker: char,
    run: usize,
    column: usize,
    /// Open list items: (content column, started empty).
    items: Vec<(usize, bool)>,
    /// The previous line may be paragraph text, so this one may continue it.
    paragraph: bool,
}

impl Reading {
    fn start() -> Self {
        Reading {
            fence: 0,
            marker: '\0',
            run: 0,
            column: 0,
            items: Vec::new(),
            paragraph: false,
        }
    }

    fn plain(items: Vec<(usize, bool)>, paragraph: bool) -> Self {
        Reading {
            items,
            paragraph,
            ..Reading::start()
        }
    }

    fn fenced(
        fence: u8,
        (marker, run): (char, usize),
        column: usize,
        items: Vec<(usize, bool)>,
    ) -> Self {
        Reading {
            fence,
            marker,
            run,
            column,
            items,
            paragraph: false,
        }
    }
}

/// The lines the viewer numbers (`\r\n`, `\r` and `\n` all end one).
fn lines(markdown: &str) -> Vec<&str> {
    let b = markdown.as_bytes();
    let mut out = Vec::new();
    let (mut start, mut i) = (0, 0);
    while i < b.len() {
        match b[i] {
            b'\n' => {
                out.push(&markdown[start..i]);
                i += 1;
                start = i;
            }
            b'\r' => {
                out.push(&markdown[start..i]);
                i += if b.get(i + 1) == Some(&b'\n') { 2 } else { 1 };
                start = i;
            }
            _ => i += 1,
        }
    }
    out.push(&markdown[start..]);
    if out.last() == Some(&"") {
        out.pop();
    }
    out
}

fn blank(line: &str) -> bool {
    line.trim_matches([' ', '\t']).is_empty()
}

/// (column, index) after the spaces and tabs from `line[i]` at `col`.
fn indent(line: &str, mut i: usize, mut col: usize) -> (usize, usize) {
    let b = line.as_bytes();
    while i < b.len() && matches!(b[i], b' ' | b'\t') {
        col = if b[i] == b'\t' {
            col + 4 - col % 4
        } else {
            col + 1
        };
        i += 1;
    }
    (col, i)
}

/// A fence opener's marker and run length.
fn fence(rest: &str) -> Option<(char, usize)> {
    let marker = rest.chars().next().filter(|c| matches!(c, '`' | '~'))?;
    let run = rest.len() - rest.trim_start_matches(marker).len();
    if run < 3 || (marker == '`' && rest[run..].contains('`')) {
        return None;
    }
    Some((marker, run))
}

fn closes(rest: &str, marker: char, run: usize) -> bool {
    let n = rest.len() - rest.trim_start_matches(marker).len();
    n >= run && rest[n..].trim_matches([' ', '\t']).is_empty()
}

/// A list marker at `line[i]` (column `col`): its item's content column, the
/// index of its content (None when the item starts empty or with indented
/// code) and whether the item starts empty.
fn list_marker(line: &str, i: usize, col: usize) -> Option<(usize, Option<usize>, bool)> {
    let b = line.as_bytes();
    let mut j = i;
    if matches!(b.get(j), Some(b'-' | b'+' | b'*')) {
        j += 1;
    } else {
        while j < b.len() && j - i < 9 && b[j].is_ascii_digit() {
            j += 1;
        }
        if j == i || !matches!(b.get(j), Some(b'.' | b')')) {
            return None;
        }
        j += 1;
    }
    if j < b.len() && !matches!(b[j], b' ' | b'\t') {
        return None;
    }
    let marker_end = col + j - i;
    let (after, k) = indent(line, j, marker_end);
    if k == b.len() {
        return Some((marker_end + 1, None, true));
    }
    if after - marker_end > 4 {
        return Some((marker_end + 1, None, false));
    }
    Some((after, Some(k), false))
}

/// A thematic break: three or more of one of `*`, `-`, `_`, with spaces or
/// tabs between.
fn thematic_break(s: &str) -> bool {
    let Some(c) = s.chars().next().filter(|c| matches!(c, '*' | '-' | '_')) else {
        return false;
    };
    s.chars().all(|x| x == c || x == ' ' || x == '\t') && s.matches(c).count() >= 3
}

/// The readings after `line` from one reading, each with whether the line is
/// code in it.
fn step(state: &Reading, line: &str) -> Vec<(Reading, bool)> {
    let (col, i) = indent(line, 0, 0);
    if i == line.len() {
        if state.fence != 0 {
            return vec![(
                Reading {
                    paragraph: false,
                    ..state.clone()
                },
                true,
            )];
        }
        let items = state.items.iter().copied().filter(|x| !x.1).collect();
        return vec![(Reading::plain(items, false), false)];
    }
    let items: Vec<(usize, bool)> = state.items.iter().map(|&(c, _)| (c, false)).collect();
    match state.fence {
        1 => {
            if col < 4 && closes(&line[i..], state.marker, state.run) {
                return vec![(Reading::start(), true)];
            }
            vec![(state.clone(), true)]
        }
        2 => {
            if col >= state.column {
                if col - state.column < 4 && closes(&line[i..], state.marker, state.run) {
                    return vec![(Reading::plain(items, false), true)];
                }
                return vec![(
                    Reading::fenced(2, (state.marker, state.run), state.column, items),
                    true,
                )];
            }
            let inner = items.into_iter().filter(|x| x.0 <= col).collect();
            plain(inner, false, line, col, i)
        }
        _ => plain(items, state.paragraph, line, col, i),
    }
}

/// Readings for a non-blank line outside fenced code.
fn plain(
    items: Vec<(usize, bool)>,
    paragraph: bool,
    line: &str,
    col: usize,
    i: usize,
) -> Vec<(Reading, bool)> {
    let rest = &line[i..];
    let inner: Vec<(usize, bool)> = items.iter().copied().filter(|x| x.0 <= col).collect();
    let relative = col - inner.last().map_or(0, |x| x.0);
    if relative < 4 {
        if let Some(opener) = fence(rest) {
            return vec![match inner.last() {
                Some(&(column, _)) => (Reading::fenced(2, opener, column, inner), false),
                None => (Reading::fenced(1, opener, 0, Vec::new()), false),
            }];
        }
        if rest.starts_with('>') {
            return vec![(Reading::plain(inner, true), false)];
        }
    }
    let mut out = Vec::new();
    if paragraph && inner.len() < items.len() {
        out.push((Reading::plain(items, true), false));
    }
    if relative >= 4 {
        out.push((Reading::plain(inner, paragraph), !paragraph));
        return out;
    }
    let mut added = inner.clone();
    let (mut at, mut at_col) = (Some(i), col);
    while let Some(k) = at {
        if thematic_break(&line[k..]) {
            break;
        }
        let Some((content, next, empty)) = list_marker(line, k, at_col) else {
            break;
        };
        added.push((content, empty));
        at = next;
        at_col = content;
    }
    if added.len() == inner.len() {
        out.push((Reading::plain(inner, true), false));
        return out;
    }
    if paragraph {
        out.push((Reading::plain(inner, true), false));
    }
    let column = added.last().map_or(0, |x| x.0);
    match at.and_then(|k| fence(&line[k..])) {
        Some(opener) => out.push((Reading::fenced(2, opener, column, added), false)),
        None => out.push((Reading::plain(added, true), false)),
    }
    out
}

/// JavaScript's `trim` whitespace: what the viewer's insert rule strips.
fn js_space(c: char) -> bool {
    matches!(
        c,
        ' ' | '\t' | '\u{0b}' | '\u{0c}' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

/// Whether the line, past anything that could be container markers or
/// whitespace, starts with something an HTML block could start with.
fn html_start(line: &str) -> bool {
    let rest = line.trim_start_matches(|c: char| {
        js_space(c) || matches!(c, '>' | '-' | '+' | '*' | '.' | ')' | '0'..='9')
    });
    let mut chars = rest.chars();
    if chars.next() != Some('<') {
        return false;
    }
    match chars.next() {
        Some('!' | '?' | '/') => true,
        Some(c) if c.is_ascii_alphabetic() => {
            let name = chars.as_str();
            let tail = name.trim_start_matches(|c: char| c.is_ascii_alphanumeric() || c == '-');
            tail.chars()
                .next()
                .is_none_or(|c| js_space(c) || matches!(c, '/' | '>'))
        }
        _ => false,
    }
}

/// A canonical insert's attribute and investigation warnings, each once.
fn card_warnings(
    spec: &InsertSpec,
    attrs: &[(String, String)],
    known: &BTreeSet<&str>,
    seen: &mut BTreeSet<(&'static str, String)>,
    out: &mut Vec<OverviewWarning>,
) {
    let tag = &spec.tag;
    for (name, _) in attrs {
        if !spec.attributes.iter().any(|a| a == name) && seen.insert(("attribute", name.clone())) {
            out.push(OverviewWarning {
                code: "unknown_attribute".into(),
                message: format!(
                    "<{tag}> has an unknown attribute \"{name}\"; the viewer ignores it"
                ),
                investigation: None,
                attribute: Some(name.clone()),
                line: None,
                reason: None,
            });
        }
    }
    let id = attrs
        .iter()
        .find(|(n, _)| *n == spec.reference)
        .map_or("", |(_, v)| v.as_str());
    if !known.contains(id) && seen.insert(("investigation", id.to_string())) {
        let message = if id.is_empty() {
            format!(
                "<{tag}> names no investigation; the viewer shows \"Investigation unavailable\""
            )
        } else {
            format!(
                "<{tag}> names \"{id}\", which is not an investigation in this project; the viewer shows \"Investigation unavailable\""
            )
        };
        out.push(OverviewWarning {
            code: "unknown_investigation".into(),
            message,
            investigation: Some(id.to_string()),
            attribute: None,
            line: None,
            reason: None,
        });
    }
}

// A canonical insert's attributes, as the HTML parser reads its start tag.

/// HTML's ASCII whitespace.
fn html_space(b: u8) -> bool {
    matches!(b, b' ' | b'\t' | b'\n' | b'\r' | 0x0c)
}

type Attributes = Vec<(String, String)>;

/// Tag name (from its first letter at `at`), attributes and the index after
/// `>`; None when the text ends inside the tag.
fn start_tag(text: &str, at: usize) -> Option<(String, Attributes, usize)> {
    let b = text.as_bytes();
    let n = b.len();
    let mut i = at;
    while i < n && !html_space(b[i]) && b[i] != b'/' && b[i] != b'>' {
        i += 1;
    }
    let name = text[at..i].to_ascii_lowercase().replace('\0', "\u{fffd}");
    let mut attrs: Attributes = Vec::new();
    loop {
        while i < n && html_space(b[i]) {
            i += 1;
        }
        match b.get(i)? {
            b'>' => return Some((name, attrs, i + 1)),
            b'/' => {
                i += 1;
                continue;
            }
            _ => {}
        }
        let name_start = i;
        // The first character belongs to the name, even a '='.
        i += text[i..].chars().next().map_or(1, char::len_utf8);
        while i < n && !html_space(b[i]) && !matches!(b[i], b'/' | b'>' | b'=') {
            i += 1;
        }
        let attr = text[name_start..i].to_ascii_lowercase();
        let mut j = i;
        while j < n && html_space(b[j]) {
            j += 1;
        }
        let mut value = String::new();
        if b.get(j) == Some(&b'=') {
            j += 1;
            while j < n && html_space(b[j]) {
                j += 1;
            }
            match *b.get(j)? {
                q @ (b'"' | b'\'') => {
                    let close = text[j + 1..].find(q as char)? + j + 1;
                    value = decode(&text[j + 1..close]);
                    i = close + 1;
                }
                _ => {
                    let from = j;
                    while j < n && !html_space(b[j]) && b[j] != b'>' {
                        j += 1;
                    }
                    value = decode(&text[from..j]);
                    i = j;
                }
            }
        }
        if !attrs.iter().any(|(a, _)| *a == attr) {
            attrs.push((attr, value));
        }
    }
}

const NAMED: &[(&str, char)] = &[
    ("amp", '&'),
    ("lt", '<'),
    ("gt", '>'),
    ("quot", '"'),
    ("apos", '\''),
];
/// Legacy names the HTML parser also reads without `;`.
const LEGACY: &[&str] = &["amp", "quot", "lt", "gt"];

/// Numeric references to C1 controls, which HTML reads as windows-1252.
fn windows_1252(code: u32) -> u32 {
    match code {
        0x80 => 0x20AC,
        0x82 => 0x201A,
        0x83 => 0x0192,
        0x84 => 0x201E,
        0x85 => 0x2026,
        0x86 => 0x2020,
        0x87 => 0x2021,
        0x88 => 0x02C6,
        0x89 => 0x2030,
        0x8A => 0x0160,
        0x8B => 0x2039,
        0x8C => 0x0152,
        0x8E => 0x017D,
        0x91 => 0x2018,
        0x92 => 0x2019,
        0x93 => 0x201C,
        0x94 => 0x201D,
        0x95 => 0x2022,
        0x96 => 0x2013,
        0x97 => 0x2014,
        0x98 => 0x02DC,
        0x99 => 0x2122,
        0x9A => 0x0161,
        0x9B => 0x203A,
        0x9C => 0x0153,
        0x9E => 0x017E,
        0x9F => 0x0178,
        other => other,
    }
}

/// A numeric reference at `value[at] == '#'`: the character and the index
/// after it, or None without digits.
fn numeric(value: &str, at: usize) -> Option<(char, usize)> {
    let b = value.as_bytes();
    let mut i = at + 1;
    let hex = matches!(b.get(i), Some(b'x' | b'X'));
    if hex {
        i += 1;
    }
    let radix = if hex { 16 } else { 10 };
    let start = i;
    let mut code: u32 = 0;
    while let Some(d) = b.get(i).and_then(|&c| (c as char).to_digit(radix)) {
        code = (code * radix + d).min(0x110000);
        i += 1;
    }
    if i == start {
        return None;
    }
    if b.get(i) == Some(&b';') {
        i += 1;
    }
    let ch = if code == 0 {
        '\u{fffd}'
    } else {
        char::from_u32(windows_1252(code)).unwrap_or('\u{fffd}')
    };
    Some((ch, i))
}

/// Character references in an attribute value, as the HTML parser reads
/// them: numeric ones (with or without `;`), the five XML names with `;`, and
/// `&amp`, `&quot`, `&lt`, `&gt` without one unless a letter, digit or `=`
/// follows. Other names stay as written; insert ids are plain ASCII.
fn decode(value: &str) -> String {
    let b = value.as_bytes();
    let mut out = String::with_capacity(value.len());
    let mut i = 0;
    while let Some(at) = value[i..].find('&').map(|k| k + i) {
        out.push_str(&value[i..at]);
        if b.get(at + 1) == Some(&b'#') {
            if let Some((ch, next)) = numeric(value, at + 1) {
                out.push(ch);
                i = next;
                continue;
            }
        } else {
            let named = value[at + 1..].find(';').and_then(|semi| {
                NAMED
                    .iter()
                    .find(|(n, _)| *n == &value[at + 1..at + 1 + semi])
            });
            if let Some((name, ch)) = named {
                out.push(*ch);
                i = at + 2 + name.len();
                continue;
            }
            if let Some(name) = LEGACY.iter().find(|n| value[at + 1..].starts_with(*n)) {
                let after = b.get(at + 1 + name.len());
                if !after.is_some_and(|c| c.is_ascii_alphanumeric() || *c == b'=') {
                    out.push(NAMED.iter().find(|(n, _)| n == name).unwrap().1);
                    i = at + 1 + name.len();
                    continue;
                }
            }
        }
        out.push('&');
        i = at + 1;
    }
    out.push_str(&value[i..]);
    out
}

impl Workbook {
    /// Append `markdown` as the project's latest overview by `author`
    /// (OV-4). Returns (latest, changed, warnings): a body whose digest is the
    /// latest version's adds no row (`changed = false`). The first overview
    /// write moves the workbook to format 3 in the same transaction (OV-2);
    /// SDKs that read up to format 2 cannot open it afterwards.
    pub fn put_overview(
        &self,
        markdown: &str,
        author: &str,
    ) -> Result<(StoredOverview, bool, Vec<OverviewWarning>)> {
        check_write(markdown, author)?;
        if let Some(r) = self.remote() {
            return r.put_overview(self.id(), markdown, author);
        }
        let digest = canonical::sha256_hex([markdown.as_bytes()]);
        let mut conn = self.conn()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        schema::upgrade(
            &tx,
            &self.path().display().to_string(),
            schema::OVERVIEW_VERSION,
        )?;
        let ids: Vec<String> = projections::investigations(&tx)?
            .into_iter()
            .map(|i| i.id)
            .collect();
        let warnings = check_overview(markdown, &ids);
        if let Some(old) = latest(&tx, self.id())? {
            if old.digest == digest {
                tx.commit()?;
                return Ok((old, false, warnings));
            }
        }
        let created = now_ts();
        tx.execute(
            "INSERT INTO overviews (project, digest, markdown, author, created) VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![self.id(), digest, markdown, author, created],
        )?;
        let seq = tx.last_insert_rowid();
        tx.commit()?;
        Ok((
            StoredOverview {
                seq,
                digest,
                markdown: markdown.to_string(),
                author: author.to_string(),
                created,
            },
            true,
            warnings,
        ))
    }

    /// The latest overview, or None. Reading never creates the table or
    /// changes the format, so formats 1 and 2 read as None.
    pub fn overview(&self) -> Result<Option<StoredOverview>> {
        if let Some(r) = self.remote() {
            return r.overview(self.id());
        }
        latest(&*self.conn()?, self.id())
    }

    /// The latest version's `seq` and `digest`, or None: one row
    /// without the Markdown, for pollers that read the body only when the
    /// digest changes. A remote workbook has no head-only route and reads the
    /// latest version (at most [`MAX_OVERVIEW_BYTES`]).
    pub fn overview_head(&self) -> Result<Option<OverviewHead>> {
        if let Some(r) = self.remote() {
            return Ok(r.overview(self.id())?.map(|o| OverviewHead {
                seq: o.seq,
                digest: o.digest,
            }));
        }
        let conn = self.conn()?;
        if !table_exists(&conn)? {
            return Ok(None);
        }
        Ok(conn
            .query_row(
                "SELECT seq, digest FROM overviews WHERE project = ?1 ORDER BY seq DESC LIMIT 1",
                [self.id()],
                |r| {
                    Ok(OverviewHead {
                        seq: r.get(0)?,
                        digest: r.get(1)?,
                    })
                },
            )
            .optional()?)
    }

    /// Every overview version, oldest first (empty before the first write).
    pub fn overview_versions(&self) -> Result<Vec<StoredOverview>> {
        if let Some(r) = self.remote() {
            return r.overview_versions(self.id());
        }
        let conn = self.conn()?;
        if !table_exists(&conn)? {
            return Ok(Vec::new());
        }
        let mut stmt = conn.prepare(
            "SELECT seq, digest, markdown, author, created FROM overviews WHERE project = ?1 ORDER BY seq",
        )?;
        let rows = stmt.query_map([self.id()], row)?;
        rows.map(|r| r.map_err(Error::from)).collect()
    }
}

fn table_exists(conn: &Connection) -> Result<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'overviews')",
        [],
        |r| r.get(0),
    )?)
}

fn row(r: &rusqlite::Row<'_>) -> rusqlite::Result<StoredOverview> {
    Ok(StoredOverview {
        seq: r.get(0)?,
        digest: r.get(1)?,
        markdown: r.get(2)?,
        author: r.get(3)?,
        created: r.get(4)?,
    })
}

/// The highest-`seq` version, or None (also without the table).
pub(super) fn latest(conn: &Connection, project: &str) -> Result<Option<StoredOverview>> {
    if !table_exists(conn)? {
        return Ok(None);
    }
    Ok(conn
        .query_row(
            "SELECT seq, digest, markdown, author, created FROM overviews WHERE project = ?1 ORDER BY seq DESC LIMIT 1",
            [project],
            row,
        )
        .optional()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    const CASES: &str = include_str!("../../../../tests/conformance/overview/cases.json");

    fn cases() -> Value {
        serde_json::from_str(CASES).unwrap()
    }

    fn known(cases: &Value) -> Vec<String> {
        cases["investigations"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_string())
            .collect()
    }

    /// Where the lint reports nothing, its canonical lines are the viewer's
    /// cards and the viewer displays the document: each vector gives the
    /// lines of the viewer's cards and whether it displays the document, and
    /// html/routes/overview-vectors.deno.test.ts checks those against the
    /// bundled parser.
    #[test]
    fn a_warning_free_vector_renders_its_canonical_lines_as_cards() {
        let cases = cases();
        let known = known(&cases);
        for case in cases["warnings"].as_array().unwrap() {
            let (warnings, cards) = lint(case["markdown"].as_str().unwrap(), &known);
            if warnings.is_empty() {
                assert_eq!(serde_json::json!(cards), case["cards"], "{}", case["name"]);
                assert_eq!(case["renders"], true, "{}", case["name"]);
            }
        }
    }

    /// The shared generator (cases.json "generator"): canonical inserts
    /// among ordinary Markdown blocks, apart by blank lines. Python's test and
    /// the deno test build the same documents.
    fn generated(cases: &Value) -> Vec<(String, Vec<usize>)> {
        let g = &cases["generator"];
        let blocks: Vec<&str> = g["blocks"]
            .as_array()
            .unwrap()
            .iter()
            .map(|b| b.as_str().unwrap())
            .collect();
        let ids = known(cases);
        let insert = g["insert"].as_str().unwrap();
        let mut seed = g["seed"].as_u64().unwrap() as u32;
        let mut next = || {
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            seed as usize
        };
        let mut docs = Vec::new();
        for d in 0..g["documents"].as_u64().unwrap() {
            let (mut parts, mut lines, mut line, mut word) = (Vec::new(), Vec::new(), 1, 0);
            for _ in 0..1 + next() % g["max_blocks"].as_u64().unwrap() as usize {
                let r = next() % (blocks.len() + g["insert_slots"].as_u64().unwrap() as usize);
                let text = if r >= blocks.len() {
                    lines.push(line);
                    insert
                        .replace("{id}", &ids[next() % ids.len()])
                        .replace("{n}", &lines.len().to_string())
                } else {
                    let mut text = blocks[r].to_string();
                    while text.contains("{w}") {
                        text = text.replacen("{w}", &format!("w{d}x{word}z"), 1);
                        word += 1;
                    }
                    text
                };
                line += text.matches('\n').count() + 2;
                parts.push(text);
            }
            docs.push((parts.join("\n\n") + "\n", lines));
        }
        docs
    }

    #[test]
    fn generated_documents_have_no_warnings_and_one_card_per_insert() {
        let cases = cases();
        let known = known(&cases);
        let docs = generated(&cases);
        assert_eq!(
            docs.len(),
            cases["generator"]["documents"].as_u64().unwrap() as usize
        );
        let all: String = docs.iter().map(|(m, _)| m.as_str()).collect();
        assert_eq!(
            canonical::sha256_hex([all.as_bytes()]),
            cases["generator"]["digest"].as_str().unwrap()
        );
        for (markdown, inserts) in &docs {
            assert_eq!(
                lint(markdown, &known),
                (Vec::new(), inserts.clone()),
                "{markdown:?}"
            );
        }
        assert!(docs.iter().filter(|(_, i)| !i.is_empty()).count() > docs.len() / 2);
    }

    #[test]
    fn attribute_values_decode_as_the_html_parser_does() {
        for (raw, want) in [
            ("a&amp;b", "a&b"),
            ("a&ampb", "a&ampb"),
            ("a&amp b", "a& b"),
            ("a&amp=b", "a&amp=b"),
            ("&#95x&#x80;", "_x\u{20ac}"),
            ("&#0;&#xD800;&#x110000;", "\u{fffd}\u{fffd}\u{fffd}"),
            ("&bogus;&", "&bogus;&"),
            ("&#;", "&#;"),
        ] {
            assert_eq!(decode(raw), want, "{raw}");
        }
    }
}
