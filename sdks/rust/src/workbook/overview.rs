//! Project overviews (workbook format 3, OV-1 to OV-4): an append-only
//! history of one Markdown research note per project, independent of the
//! records, config hashes and display. `verify` and `rebuild_projections`
//! ignore it, as they ignore display.
//!
//! Validation is advisory (OV-3): a write is refused only for an empty body,
//! a body over [`MAX_OVERVIEW_BYTES`] or a missing author. Inserts that name
//! an investigation the workbook does not hold, insert attributes the viewer
//! does not know, and Markdown the viewer will not render as written (OV-9)
//! come back as [`OverviewWarning`]s. The insert tags and their attribute
//! keys are read from `html/ui/investigation-inserts.json`, the list the
//! browser's document view registers. Where a card renders is decided by
//! [`blocks`], a port of the viewer's block parser; Python's
//! `autophys.overview` has the same rules and
//! `tests/conformance/overview/cases.json` pins both.
use std::collections::BTreeSet;
use std::sync::OnceLock;

use super::overview_blocks::{self as blocks, Found, js_trim};

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

/// An advisory finding about an overview write; the write still happened.
/// `code` is one of:
///
/// - `unknown_investigation` (with `investigation`, empty when the insert
///   names none): a card the viewer shows as "Investigation unavailable";
/// - `unknown_attribute` (with `attribute`): an attribute the viewer ignores;
/// - `insert_in_paragraph` (with `line`): an insert line that continues the
///   text above it, so the viewer renders no card;
/// - `unclosed_insert` (with `line`): a card whose closing tag comes lines
///   later or never, so the viewer hides the lines in between;
/// - `html_block` (with `line`): an HTML block, which stops the viewer
///   displaying the whole overview.
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
}

impl OverviewWarning {
    fn at_line(code: &str, message: String, line: usize) -> Self {
        OverviewWarning {
            code: code.into(),
            message,
            investigation: None,
            attribute: None,
            line: Some(line),
        }
    }
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
/// investigations `known` (OV-3, OV-9), in document order, each attribute and
/// investigation finding once. Cards are found where the viewer renders them.
pub fn check_overview<S: AsRef<str>>(markdown: &str, known: &[S]) -> Vec<OverviewWarning> {
    let known: BTreeSet<&str> = known.iter().map(AsRef::as_ref).collect();
    let specs = inserts();
    let tags: Vec<&str> = specs.iter().map(|s| s.tag.as_str()).collect();
    let spec_of = |tag: &str| specs.iter().find(|s| s.tag == tag);
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for found in blocks::blocks(markdown, &tags) {
        match found {
            Found::HtmlBlock { line } => {
                let line = line + 1;
                out.push(OverviewWarning::at_line(
                    "html_block",
                    format!(
                        "line {line} starts an HTML block, which the viewer cannot display; it shows \"The document could not be displayed\" instead of the overview"
                    ),
                    line,
                ));
            }
            Found::Continued { tag, line } => {
                // The viewer's built-in insert is not ours to place.
                if spec_of(&tag).is_some() {
                    let line = line + 1;
                    out.push(OverviewWarning::at_line(
                        "insert_in_paragraph",
                        format!(
                            "<{tag}> on line {line} continues the text above it, so the viewer shows no card; put a blank line before it"
                        ),
                        line,
                    ));
                }
            }
            Found::Card {
                tag,
                line,
                content,
                end,
                closed,
            } => {
                let line = line + 1;
                if let Some(spec) = spec_of(&tag) {
                    let attrs =
                        element_attributes(&content, &tag.to_ascii_lowercase()).unwrap_or_default();
                    card_warnings(spec, &attrs, &known, &mut seen, &mut out);
                }
                if hides_lines(&content, &tag) {
                    let until = if closed {
                        format!("is not closed until line {end}")
                    } else {
                        format!("is never closed with </{tag}>")
                    };
                    out.push(OverviewWarning::at_line(
                        "unclosed_insert",
                        format!(
                            "<{tag}> on line {line} {until}, so the viewer hides lines {} to {end}",
                            line + 1
                        ),
                        line,
                    ));
                }
            }
        }
    }
    out
}

/// A rendered card's attribute and investigation warnings, each once.
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
        });
    }
}

/// Whether a card token runs past its first line and holds text besides its
/// start tag and closing tag: the viewer shows none of that text. A start tag
/// with its attributes over several lines hides nothing; one cut off by the
/// end of the block hides every line after it.
fn hides_lines(content: &str, tag: &str) -> bool {
    if !content.contains('\n') {
        return false;
    }
    let parsed = content
        .find(&format!("<{tag}"))
        .and_then(|at| start_tag(content, at + 1));
    match parsed {
        None => content.split('\n').skip(1).any(|s| !js_trim(s).is_empty()),
        Some((_, _, end)) => {
            !js_trim(&content[end..].replacen(&format!("</{tag}>"), "", 1)).is_empty()
        }
    }
}

// The viewer's getAttrs: the first <tag> element of the card's HTML.

const RAW_TEXT: &[&str] = &[
    "script", "style", "xmp", "iframe", "noembed", "noframes", "noscript", "textarea", "title",
];

/// HTML's ASCII whitespace.
fn html_space(b: u8) -> bool {
    matches!(b, b' ' | b'\t' | b'\n' | b'\r' | 0x0c)
}

/// The attributes of the first `tag` element (lowercase) the HTML parser
/// makes of `html`, as the viewer's `getAttrs` reads them through `innerHTML`
/// and `querySelector`: names lowercased, values decoded, the first of a
/// repeated name kept. None when there is no such element, which includes a
/// tag cut off by the end of the text.
fn element_attributes(html: &str, tag: &str) -> Option<Vec<(String, String)>> {
    let b = html.as_bytes();
    let n = b.len();
    let find = |pat: &str, from: usize| html[from..].find(pat).map(|k| k + from);
    let mut i = 0;
    loop {
        let lt = find("<", i)?;
        if lt + 1 >= n {
            return None;
        }
        match b[lt + 1] {
            b'!' => {
                if html[lt..].starts_with("<!--") {
                    let j = lt + 4;
                    if html[j..].starts_with('>') {
                        i = j + 1;
                    } else if html[j..].starts_with("->") {
                        i = j + 2;
                    } else {
                        let k = [find("-->", j), find("--!>", j)]
                            .into_iter()
                            .flatten()
                            .min()?;
                        i = k + if html[k..].starts_with("-->") { 3 } else { 4 };
                    }
                } else {
                    i = find(">", lt + 2)? + 1;
                }
                continue;
            }
            b'?' => {
                i = find(">", lt + 2)? + 1;
                continue;
            }
            _ => {}
        }
        let closing = b[lt + 1] == b'/';
        let start = if closing { lt + 2 } else { lt + 1 };
        if start >= n {
            return None;
        }
        if !b[start].is_ascii_alphabetic() {
            i = if closing && b[start] == b'>' {
                start + 1
            } else if closing {
                find(">", start)? + 1
            } else {
                lt + 1
            };
            continue;
        }
        let (name, attrs, after) = start_tag(html, start)?;
        i = after;
        if closing {
            continue;
        }
        if name == tag {
            return Some(attrs);
        }
        if name == "plaintext" {
            return None;
        }
        if RAW_TEXT.contains(&name.as_str()) {
            i = raw_text_end(html, i, &name)?;
        }
    }
}

/// Where the `</name` that ends a raw text element starts, or None.
fn raw_text_end(html: &str, mut i: usize, name: &str) -> Option<usize> {
    let lowered = html.to_ascii_lowercase();
    let closing = format!("</{name}");
    loop {
        let k = lowered[i..].find(&closing)? + i;
        let after = k + closing.len();
        match html.as_bytes().get(after) {
            None => return Some(k),
            Some(&c) if html_space(c) || c == b'/' || c == b'>' => return Some(k),
            _ => i = after,
        }
    }
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
            return Ok(r.snapshot(self.id())?.overview);
        }
        latest(&*self.conn()?, self.id())
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

    const CASES: &str = include_str!("../../../../tests/conformance/overview/cases.json");

    /// The block pass puts cards and HTML blocks where the viewer does: each
    /// vector gives the lines of its <ap-investigation> cards and whether the
    /// viewer can display it (html/routes/overview-vectors.deno.test.ts checks the
    /// same against the bundled parser).
    #[test]
    fn cards_and_renders_match_the_shared_vectors() {
        let cases: serde_json::Value = serde_json::from_str(CASES).unwrap();
        let tags: Vec<&str> = inserts().iter().map(|s| s.tag.as_str()).collect();
        for case in cases["warnings"].as_array().unwrap() {
            let found = blocks::blocks(case["markdown"].as_str().unwrap(), &tags);
            let cards: Vec<usize> = found
                .iter()
                .filter_map(|f| match f {
                    Found::Card { tag, line, .. } if tag == "ap-investigation" => Some(line + 1),
                    _ => None,
                })
                .collect();
            let renders = !found.iter().any(|f| matches!(f, Found::HtmlBlock { .. }));
            assert_eq!(
                serde_json::json!(cards),
                case["cards"],
                "{}: cards",
                case["name"]
            );
            assert_eq!(
                serde_json::json!(renders),
                case["renders"],
                "{}: renders",
                case["name"]
            );
        }
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
