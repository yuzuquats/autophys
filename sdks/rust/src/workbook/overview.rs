//! Project overviews (workbook format 3, OV-1 to OV-4): an append-only
//! history of one Markdown research note per project, independent of the
//! records, config hashes and display. `verify` and `rebuild_projections`
//! ignore it, as they ignore display.
//!
//! Validation is advisory (OV-3): a write is refused only for an empty body,
//! a body over [`MAX_OVERVIEW_BYTES`] or a missing author. Inserts that name
//! an investigation the workbook does not hold, and insert attributes the
//! viewer does not know, come back as [`OverviewWarning`]s. The insert tags
//! and their attribute keys are read from `html/ui/investigation-inserts.json`,
//! the list the browser's document view registers.
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

/// An advisory finding about an overview write; the write still happened.
/// `code` is `unknown_investigation` (with `investigation`, empty when the
/// insert names none) or `unknown_attribute` (with `attribute`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct OverviewWarning {
    pub code: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub investigation: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attribute: Option<String>,
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
pub(crate) const INSERTS_JSON: &str = include_str!("../../../../html/ui/investigation-inserts.json");

fn inserts() -> &'static [InsertSpec] {
    static SPECS: OnceLock<Vec<InsertSpec>> = OnceLock::new();
    SPECS.get_or_init(|| {
        let file: InsertFile = serde_json::from_str(INSERTS_JSON).expect("investigation-inserts.json");
        file.inserts
            .into_iter()
            .map(|i| InsertSpec { tag: i.tag.to_ascii_lowercase(), reference: i.reference, attributes: i.attributes })
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
        return Err(Error::invalid("author", "required string of 1 to 200 characters"));
    }
    Ok(())
}

/// The advisory warnings for `markdown` in a workbook holding the
/// investigations `known` (OV-3), in document order, each finding once.
/// An insert is an HTML block: its tag starts a line (after at most three
/// spaces) outside fenced code, as the viewer's Markdown parser reads it.
pub fn check_overview<S: AsRef<str>>(markdown: &str, known: &[S]) -> Vec<OverviewWarning> {
    let known: BTreeSet<&str> = known.iter().map(AsRef::as_ref).collect();
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for (spec, attrs) in scan(markdown) {
        for (name, _) in &attrs {
            if !spec.attributes.iter().any(|a| a == name) && seen.insert(("attribute", name.clone())) {
                out.push(OverviewWarning {
                    code: "unknown_attribute".into(),
                    message: format!("<{}> has an unknown attribute \"{name}\"; the viewer ignores it", spec.tag),
                    investigation: None,
                    attribute: Some(name.clone()),
                });
            }
        }
        let id = attrs.iter().find(|(n, _)| *n == spec.reference).map_or("", |(_, v)| v.as_str());
        if !known.contains(id) && seen.insert(("investigation", id.to_string())) {
            let message = if id.is_empty() {
                format!("<{}> names no investigation; the viewer shows \"Investigation unavailable\"", spec.tag)
            } else {
                format!(
                    "<{}> names \"{id}\", which is not an investigation in this project; the viewer shows \"Investigation unavailable\"",
                    spec.tag
                )
            };
            out.push(OverviewWarning {
                code: "unknown_investigation".into(),
                message,
                investigation: Some(id.to_string()),
                attribute: None,
            });
        }
    }
    out
}

/// Every insert tag in `markdown` with its attributes (lowercased names,
/// decoded values, first occurrence wins), in document order.
fn scan(markdown: &str) -> Vec<(&'static InsertSpec, Vec<(String, String)>)> {
    let mut out = Vec::new();
    let mut fence: Option<(u8, usize)> = None;
    let mut start = 0;
    while start < markdown.len() {
        let end = markdown[start..].find('\n').map_or(markdown.len(), |i| start + i);
        let line = markdown[start..end].strip_suffix('\r').unwrap_or(&markdown[start..end]);
        let indent = line.bytes().take_while(|&b| b == b' ').count();
        let rest = &line[indent..];
        let run = |c: u8| rest.bytes().take_while(|&b| b == c).count();
        match fence {
            Some((c, n)) => {
                if indent <= 3 && run(c) >= n && rest[run(c)..].trim_matches([' ', '\t']).is_empty() {
                    fence = None;
                }
            }
            None if indent <= 3 && (run(b'`') >= 3 || run(b'~') >= 3) => {
                let c = rest.as_bytes()[0];
                let n = run(c);
                if c != b'`' || !rest[n..].contains('`') {
                    fence = Some((c, n));
                }
            }
            None if indent <= 3 && rest.starts_with('<') => {
                if let Some(found) = insert_at(&markdown[start + indent..]) {
                    out.push(found);
                }
            }
            None => {}
        }
        start = end + 1;
    }
    out
}

fn is_space(b: u8) -> bool {
    matches!(b, b' ' | b'\t' | b'\n' | b'\r' | 0x0c)
}

/// The insert whose start tag begins `text` (at its `<`), if the tag is
/// complete.
fn insert_at(text: &str) -> Option<(&'static InsertSpec, Vec<(String, String)>)> {
    let b = text.as_bytes();
    let spec = inserts().iter().find(|s| {
        let n = s.tag.len() + 1;
        b.len() >= n
            && b[1..n].eq_ignore_ascii_case(s.tag.as_bytes())
            && b.get(n).is_none_or(|&c| is_space(c) || c == b'/' || c == b'>')
    })?;
    let mut i = spec.tag.len() + 1;
    let mut attrs: Vec<(String, String)> = Vec::new();
    loop {
        while i < b.len() && is_space(b[i]) {
            i += 1;
        }
        match b.get(i)? {
            b'>' => return Some((spec, attrs)),
            b'/' => {
                i += 1;
                continue;
            }
            _ => {}
        }
        let name_start = i;
        // The first character belongs to the name, even a '='.
        i += text[i..].chars().next().map_or(1, char::len_utf8);
        while i < b.len() && !is_space(b[i]) && !matches!(b[i], b'/' | b'>' | b'=') {
            i += 1;
        }
        let name = text[name_start..i].to_ascii_lowercase();
        let mut j = i;
        while j < b.len() && is_space(b[j]) {
            j += 1;
        }
        let mut value = String::new();
        if b.get(j) == Some(&b'=') {
            j += 1;
            while j < b.len() && is_space(b[j]) {
                j += 1;
            }
            match b.get(j)? {
                &q if q == b'"' || q == b'\'' => {
                    let close = text[j + 1..].find(q as char)? + j + 1;
                    value = decode(&text[j + 1..close]);
                    i = close + 1;
                }
                _ => {
                    let from = j;
                    while j < b.len() && !is_space(b[j]) && b[j] != b'>' {
                        j += 1;
                    }
                    value = decode(&text[from..j]);
                    i = j;
                }
            }
        }
        if !attrs.iter().any(|(n, _)| *n == name) {
            attrs.push((name, value));
        }
    }
}

/// Decode the character references an attribute value may use: the five
/// named XML ones and numeric references, each with its `;`. Anything else
/// stays as written (OV-3 warnings only need ids, which are plain ASCII).
fn decode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        rest = &rest[at..];
        let Some(semi) = rest[1..].find(';').map(|i| i + 1) else { break };
        let entity = &rest[1..semi];
        let ch = match entity {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            _ => entity
                .strip_prefix('#')
                .and_then(|n| match n.strip_prefix(['x', 'X']) {
                    Some(hex) if !hex.is_empty() && hex.bytes().all(|c| c.is_ascii_hexdigit()) => u32::from_str_radix(hex, 16).ok(),
                    None if !n.is_empty() && n.bytes().all(|c| c.is_ascii_digit()) => n.parse().ok(),
                    _ => None,
                })
                .and_then(char::from_u32),
        };
        match ch {
            Some(c) => {
                out.push(c);
                rest = &rest[semi + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
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
        schema::upgrade(&tx, &self.path().display().to_string(), schema::OVERVIEW_VERSION)?;
        let ids: Vec<String> = projections::investigations(&tx)?.into_iter().map(|i| i.id).collect();
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
            StoredOverview { seq, digest, markdown: markdown.to_string(), author: author.to_string(), created },
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
    Ok(StoredOverview { seq: r.get(0)?, digest: r.get(1)?, markdown: r.get(2)?, author: r.get(3)?, created: r.get(4)? })
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
