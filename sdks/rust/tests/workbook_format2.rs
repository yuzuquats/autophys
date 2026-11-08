//! Workbook format 2: the display table, reached at the first display write
//! (DM-D1, DM-D1a). Mirrors sdks/python/tests/test_workbook_format2.py.

use std::collections::BTreeMap;
use std::path::Path;

use autophys::{
    Error, FORMAT_VERSION, INITIAL_FORMAT_VERSION, MAX_DISPLAY_BYTES, Workbook, canonical, connect,
    sha256_hex,
};
use rusqlite::Connection;
use serde_json::{Value, json};

/// The display DDL as SQLite keeps it in sqlite_master: without
/// "IF NOT EXISTS" and the trailing ";". Both SDKs must leave this text.
const DISPLAY_SQL: &str = "CREATE TABLE display (\n              project TEXT PRIMARY KEY REFERENCES projects(id),\n              digest TEXT NOT NULL, body TEXT NOT NULL, created REAL NOT NULL\n            )";
/// What SDKs before format 2 ran on a format-1 workbook.
const LEGACY_DDL: &str = "CREATE TABLE IF NOT EXISTS display (\n              project TEXT PRIMARY KEY REFERENCES projects(id),\n              digest TEXT NOT NULL, body TEXT NOT NULL, created REAL NOT NULL\n            );";

fn manifest() -> Value {
    json!({"format": 1, "channels": {"y": {"role": "output"}}, "title": "toy"})
}

fn body() -> Vec<u8> {
    serde_json::to_vec(&manifest()).unwrap()
}

/// `(user_version, {table name: sql})`, read through a separate connection.
fn raw(path: &Path) -> (i64, BTreeMap<String, String>) {
    let conn = Connection::open(path).unwrap();
    let version = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap();
    let mut stmt = conn
        .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table'")
        .unwrap();
    let tables = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    (version, tables)
}

fn workbook(dir: &Path) -> Workbook {
    let client = connect(Some(dir.to_str().unwrap())).unwrap();
    client.ensure_project("toy").unwrap().0
}

fn reopen(path: &Path) -> Workbook {
    let client = connect(Some(path.to_str().unwrap())).unwrap();
    client.project("toy").unwrap()
}

#[test]
fn versions() {
    assert_eq!((INITIAL_FORMAT_VERSION, FORMAT_VERSION), (1, 2));
}

#[test]
fn new_workbook_is_format_1_and_opening_never_migrates() {
    let dir = tempfile::tempdir().unwrap();
    let wb = workbook(dir.path());
    let path = wb.path().to_path_buf();
    assert!(wb.display().unwrap().is_none());
    drop(wb);
    for _ in 0..2 {
        assert!(reopen(&path).display().unwrap().is_none());
    }
    let (version, tables) = raw(&path);
    assert_eq!(version, 1);
    assert!(!tables.contains_key("display"));
}

#[test]
fn first_display_write_moves_to_format_2() {
    let dir = tempfile::tempdir().unwrap();
    let wb = workbook(dir.path());
    let (stored, changed) = wb.put_display(&body()).unwrap();
    let text = canonical(&manifest());
    assert!(changed && stored.body == manifest());
    assert_eq!(stored.digest, sha256_hex([text.as_bytes()])); // bare hex, like Python
    let (version, tables) = raw(wb.path());
    assert_eq!(version, 2);
    assert_eq!(tables["display"], DISPLAY_SQL);
    let row: (String, String, String) = Connection::open(wb.path())
        .unwrap()
        .query_row("SELECT project, digest, body FROM display", [], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })
        .unwrap();
    assert_eq!(
        row,
        (wb.id().to_string(), stored.digest.clone(), text.clone())
    );
    let (again, changed) = wb.put_display(text.as_bytes()).unwrap();
    assert!(!changed);
    assert_eq!(
        again, stored,
        "an identical canonical body keeps the row and timestamp"
    );
    let mut other = manifest();
    other["title"] = json!("changed");
    let (replaced, changed) = wb
        .put_display(&serde_json::to_vec(&other).unwrap())
        .unwrap();
    assert!(changed && replaced.digest != stored.digest);
    assert_eq!(wb.display().unwrap().unwrap().body, other);
    assert_eq!(raw(wb.path()).0, 2);
}

#[test]
fn format_2_reads_back() {
    let dir = tempfile::tempdir().unwrap();
    let wb = workbook(dir.path());
    let path = wb.path().to_path_buf();
    let (stored, _) = wb.put_display(&body()).unwrap();
    drop(wb);
    let again = reopen(&path);
    assert_eq!(again.display().unwrap(), Some(stored));
    assert_eq!(again.name(), "toy");
    assert!(again.verify().unwrap().ok);
}

#[test]
fn format_1_with_legacy_table_reads_and_upgrades_on_next_write() {
    let dir = tempfile::tempdir().unwrap();
    let wb = workbook(dir.path());
    let (path, pid) = (wb.path().to_path_buf(), wb.id().to_string());
    drop(wb);
    let text = canonical(&manifest());
    let digest = sha256_hex([text.as_bytes()]);
    // What a pre-format-2 SDK left behind.
    let conn = Connection::open(&path).unwrap();
    conn.execute_batch(LEGACY_DDL).unwrap();
    conn.execute(
        "INSERT INTO display VALUES (?1, ?2, ?3, 12.5)",
        rusqlite::params![pid, digest, text],
    )
    .unwrap();
    drop(conn);
    assert_eq!(raw(&path).0, 1);
    let wb = reopen(&path);
    assert_eq!(raw(&path).0, 1, "still not on open");
    let read = wb.display().unwrap().unwrap();
    assert_eq!(
        (read.digest.as_str(), &read.body, read.created),
        (digest.as_str(), &manifest(), 12.5)
    );
    // Even an unchanged body completes the upgrade.
    let (stored, changed) = wb.put_display(&body()).unwrap();
    assert!(!changed && stored.created == 12.5);
    let (version, tables) = raw(&path);
    assert_eq!(version, 2);
    assert_eq!(tables["display"], DISPLAY_SQL);
}

#[test]
fn newer_formats_are_refused() {
    let dir = tempfile::tempdir().unwrap();
    let path = workbook(dir.path()).path().to_path_buf();
    Connection::open(&path)
        .unwrap()
        .pragma_update(None, "user_version", 3)
        .unwrap();
    let err = connect(Some(path.to_str().unwrap()))
        .unwrap()
        .project("toy")
        .unwrap_err();
    assert!(matches!(err, Error::Format(_)), "{err}");
    assert!(
        err.to_string()
            .contains("format 3; this library reads up to 2"),
        "{err}"
    );
}

#[test]
fn a_newer_format_written_after_open_is_not_downgraded() {
    let dir = tempfile::tempdir().unwrap();
    let wb = workbook(dir.path());
    Connection::open(wb.path())
        .unwrap()
        .pragma_update(None, "user_version", 3)
        .unwrap();
    let err = wb.put_display(&body()).unwrap_err();
    assert!(err.to_string().contains("format 3"), "{err}");
    let (version, tables) = raw(wb.path());
    assert_eq!(version, 3);
    assert!(!tables.contains_key("display"));
}

#[test]
fn a_failed_display_write_leaves_format_1() {
    let dir = tempfile::tempdir().unwrap();
    let wb = workbook(dir.path());
    // A view named display makes the step's CREATE ... IF NOT EXISTS a no-op
    // and the row's INSERT fail, after the step ran in the same transaction.
    Connection::open(wb.path())
        .unwrap()
        .execute_batch("CREATE VIEW display AS SELECT 1 AS project")
        .unwrap();
    assert!(wb.put_display(&body()).is_err());
    assert!(wb.display().unwrap().is_none());
    let (version, tables) = raw(wb.path());
    assert_eq!(version, 1, "the step rolled back with the write");
    assert!(!tables.contains_key("display"));
    Connection::open(wb.path())
        .unwrap()
        .execute_batch("DROP VIEW display")
        .unwrap();
    assert!(
        wb.put_display(&body()).unwrap().1,
        "the workbook is still usable"
    );
    assert_eq!(raw(wb.path()).0, 2);
}

#[test]
fn rejected_manifests_change_nothing() {
    let pad = format!(
        r#"{{"format":1,"pad":"{}"}}"#,
        "x".repeat(MAX_DISPLAY_BYTES)
    );
    let cases: [(&[u8], &str); 7] = [
        (br#"{"format":2}"#, "expected display manifest format 1"),
        (br#"{"format":1.0}"#, "expected display manifest format 1"),
        (br#"{"format":true}"#, "expected display manifest format 1"),
        (b"[1]", "expected display manifest format 1"),
        (b"not json", "must be JSON"),
        (br#"{"format":1,"x":NaN}"#, "must be JSON"),
        (pad.as_bytes(), "larger than 262144 bytes"),
    ];
    for (body, message) in cases {
        let dir = tempfile::tempdir().unwrap();
        let wb = workbook(dir.path());
        let err = wb.put_display(body).unwrap_err();
        assert!(
            err.to_string().contains(message) || format!("{err:?}").contains(message),
            "{err}"
        );
        let (version, tables) = raw(wb.path());
        assert_eq!(version, 1);
        assert!(!tables.contains_key("display"));
    }
}

/// The display digest both SDKs compute for a non-ASCII manifest: Python's
/// canonical JSON escapes to ASCII (`ensure_ascii`), as Rust's does, and both
/// sort keys by code point. The same constants are pinned in
/// sdks/python/tests/test_workbook_format2.py.
const NON_ASCII_CANONICAL: &str = r#"{"channels":{"T":{"label":"\u03b8 (\u00b0C)","unit":"\u00b0C"}},"ctl":"tab\tnl\n\u0001 \u2028","e":2,"format":1,"nums":[0.1,1e-07,1e+21,-0.0],"title":"Temp\u00e9rature \u2014 \u71b1 \ud83d\udd25","\u00e9":1,"\uffff":3,"\ud83d\ude00":4}"#;
const NON_ASCII_DIGEST: &str = "543ee13fd15bb36266fc0fe2ff74e76c62feae40e9e0fec1a54561349512c075";

#[test]
fn non_ascii_manifest_digest_matches_python() {
    let upload = "{\"format\":1,\"title\":\"Température — 熱 🔥\",\"channels\":{\"T\":{\"label\":\"θ (°C)\",\"unit\":\"°C\"}},\"é\":1,\"e\":2,\"\u{ffff}\":3,\"😀\":4,\"ctl\":\"tab\\tnl\\n\\u0001 \u{2028}\",\"nums\":[0.1,1e-7,1e21,-0.0]}";
    let dir = tempfile::tempdir().unwrap();
    let wb = workbook(dir.path());
    let (stored, _) = wb.put_display(upload.as_bytes()).unwrap();
    assert_eq!(stored.digest, NON_ASCII_DIGEST);
    assert_eq!(canonical(&stored.body), NON_ASCII_CANONICAL);
    let text: String = Connection::open(wb.path())
        .unwrap()
        .query_row("SELECT body FROM display", [], |r| r.get(0))
        .unwrap();
    assert_eq!(text, NON_ASCII_CANONICAL);
}
