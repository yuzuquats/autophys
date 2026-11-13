//! Workbook format 3: the overviews table, reached only at the first
//! overview write (OV-1 to OV-4). Display writes stop at format 2, reads
//! change nothing. The shared vectors are `tests/conformance/overview/`,
//! read the same way by sdks/python/tests/test_workbook_format3.py.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use autophys::{
    Error, FORMAT_VERSION, MAX_OVERVIEW_BYTES, OverviewWarning, Workbook, check_overview, connect,
    sha256_hex,
};
use rusqlite::Connection;
use serde_json::{Value, json};

fn shared() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/conformance/overview")
}

fn cases() -> Value {
    serde_json::from_str(&std::fs::read_to_string(shared().join("cases.json")).unwrap()).unwrap()
}

/// `(user_version, {table name: sql})`, through a separate connection.
fn raw(path: &Path) -> (i64, BTreeMap<String, String>) {
    let conn = Connection::open(path).unwrap();
    let version = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
    let mut stmt = conn.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table'").unwrap();
    let tables = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    (version, tables)
}

fn rows(path: &Path) -> i64 {
    Connection::open(path).unwrap().query_row("SELECT count(*) FROM overviews", [], |r| r.get(0)).unwrap()
}

fn workbook(dir: &Path) -> Workbook {
    connect(Some(dir.to_str().unwrap())).unwrap().ensure_project("toy").unwrap().0
}

fn reopen(path: &Path) -> Workbook {
    connect(Some(path.to_str().unwrap())).unwrap().project("toy").unwrap()
}

fn manifest() -> Vec<u8> {
    br#"{"format":1,"title":"toy"}"#.to_vec()
}

/// One investigation, so an insert has something to name.
fn with_investigation(wb: &Workbook) -> String {
    let body = br#"{"physics":true}"#;
    let version = format!("sha256:{}", sha256_hex([&body[..]]));
    wb.put_config_version(&version, body).unwrap();
    wb.create_investigation(json!({"config_version": version}), None).unwrap().0.id
}

fn file_bytes(path: &Path) -> Vec<u8> {
    std::fs::read(path).unwrap()
}

#[test]
fn versions() {
    assert_eq!(FORMAT_VERSION, 3);
    assert_eq!(MAX_OVERVIEW_BYTES, 256 * 1024);
    assert_eq!(cases()["max_bytes"], json!(MAX_OVERVIEW_BYTES));
}

#[test]
fn a_display_write_stops_at_format_2_now_that_the_current_format_is_3() {
    let dir = tempfile::tempdir().unwrap();
    let wb = workbook(dir.path());
    assert!(wb.put_display(&manifest()).unwrap().1);
    let (version, tables) = raw(wb.path());
    assert_eq!(version, 2, "display upgrades to exactly 2, not to FORMAT_VERSION");
    assert!(tables.contains_key("display") && !tables.contains_key("overviews"));
    assert!(!wb.put_display(&manifest()).unwrap().1);
    assert_eq!(raw(wb.path()).0, 2);
}

#[test]
fn reading_an_overview_never_creates_the_table_or_changes_formats_1_and_2() {
    for display in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let wb = workbook(dir.path());
        if display {
            wb.put_display(&manifest()).unwrap();
        }
        let path = wb.path().to_path_buf();
        drop(wb);
        let before = (raw(&path), file_bytes(&path));
        let wb = reopen(&path);
        assert_eq!(wb.overview().unwrap(), None);
        assert_eq!(wb.overview_versions().unwrap(), vec![]);
        assert_eq!(wb.snapshot().unwrap().overview, None);
        assert!(wb.verify().unwrap().ok);
        drop(wb);
        assert_eq!((raw(&path), file_bytes(&path)), before, "display={display}");
        assert_eq!(before.0.0, if display { 2 } else { 1 });
    }
}

#[test]
fn the_first_overview_write_moves_to_format_3_with_the_shared_ddl() {
    let dir = tempfile::tempdir().unwrap();
    let wb = workbook(dir.path());
    let inv = with_investigation(&wb);
    let md = format!("# Toy\n\n<ap-investigation investigation=\"{inv}\"></ap-investigation>\n");
    let (stored, changed, warnings) = wb.put_overview(&md, "ada").unwrap();
    assert!(changed && warnings.is_empty());
    assert_eq!((stored.seq, stored.markdown.as_str(), stored.author.as_str()), (1, md.as_str(), "ada"));
    assert_eq!(stored.digest, sha256_hex([md.as_bytes()]));
    let (version, tables) = raw(wb.path());
    assert_eq!(version, 3);
    assert_eq!(tables["overviews"], cases()["sql"].as_str().unwrap());
    assert!(tables.contains_key("display"), "format 3 includes format 2's table");
    assert_eq!(wb.overview().unwrap(), Some(stored.clone()));
    assert_eq!(wb.snapshot().unwrap().overview, Some(stored.clone()));
    assert!(wb.verify().unwrap().ok, "verify ignores overviews");
    assert!(wb.rebuild_projections().unwrap().ok);
    // A display write leaves format 3 as it is.
    wb.put_display(&manifest()).unwrap();
    assert_eq!(raw(wb.path()).0, 3);
    let path = wb.path().to_path_buf();
    drop(wb);
    assert_eq!(reopen(&path).overview().unwrap(), Some(stored));
}

#[test]
fn a_display_workbook_moves_from_2_to_3_at_its_first_overview_write() {
    let dir = tempfile::tempdir().unwrap();
    let wb = workbook(dir.path());
    let (display, _) = wb.put_display(&manifest()).unwrap();
    assert_eq!(raw(wb.path()).0, 2);
    wb.put_overview("# x\n", "ada").unwrap();
    assert_eq!(raw(wb.path()).0, 3);
    assert_eq!(wb.display().unwrap(), Some(display));
}

#[test]
fn versions_append_and_an_unchanged_body_adds_no_row() {
    let dir = tempfile::tempdir().unwrap();
    let wb = workbook(dir.path());
    let (first, changed, _) = wb.put_overview("# One\n", "ada").unwrap();
    assert!(changed);
    let (again, changed, _) = wb.put_overview("# One\n", "grace").unwrap();
    assert!(!changed, "the digest decides, not the author");
    assert_eq!(again, first);
    assert_eq!(rows(wb.path()), 1);
    let (second, changed, _) = wb.put_overview("# Two\n", "grace").unwrap();
    assert!(changed && second.seq > first.seq);
    // Back to the first body: it differs from the latest, so it is a new row.
    let (third, changed, _) = wb.put_overview("# One\n", "ada").unwrap();
    assert!(changed && third.seq > second.seq && third.digest == first.digest);
    let versions = wb.overview_versions().unwrap();
    assert_eq!(versions.iter().map(|v| v.seq).collect::<Vec<_>>(), vec![first.seq, second.seq, third.seq]);
    assert_eq!(versions[1], second);
    assert_eq!(wb.overview().unwrap(), Some(third));
}

#[test]
fn latest_is_ordered_by_seq_not_created() {
    let dir = tempfile::tempdir().unwrap();
    let wb = workbook(dir.path());
    wb.put_overview("# One\n", "ada").unwrap();
    let conn = Connection::open(wb.path()).unwrap();
    conn.execute(
        "INSERT INTO overviews (seq, project, digest, markdown, author, created) VALUES (100, ?1, ?2, '# Old clock\n', 'bob', 1.0)",
        rusqlite::params![wb.id(), sha256_hex([b"# Old clock\n".as_slice()])],
    )
    .unwrap();
    drop(conn);
    let latest = wb.overview().unwrap().unwrap();
    assert_eq!((latest.seq, latest.author.as_str(), latest.created), (100, "bob", 1.0));
    assert_eq!(wb.overview_versions().unwrap().last(), Some(&latest));
}

fn markdown_of(case: &Value) -> String {
    match case.get("markdown_repeat") {
        Some(r) => r[0].as_str().unwrap().repeat(r[1].as_u64().unwrap() as usize),
        None => case["markdown"].as_str().unwrap().to_string(),
    }
}

#[test]
fn refused_writes_change_nothing() {
    for case in cases()["refused"].as_array().unwrap() {
        let dir = tempfile::tempdir().unwrap();
        let wb = workbook(dir.path());
        let err = wb.put_overview(&markdown_of(case), case["author"].as_str().unwrap()).unwrap_err();
        assert_eq!(err.code(), case["error"].as_str().unwrap(), "{}: {err}", case["name"]);
        if let Some(path) = case.get("path") {
            assert!(matches!(&err, Error::Invalid { path: p, .. } if p == path.as_str().unwrap()), "{}: {err:?}", case["name"]);
        }
        let (version, tables) = raw(wb.path());
        assert_eq!(version, 1, "{}", case["name"]);
        assert!(!tables.contains_key("overviews"));
    }
    for case in cases()["accepted"].as_array().unwrap() {
        let dir = tempfile::tempdir().unwrap();
        let wb = workbook(dir.path());
        assert!(wb.put_overview(&markdown_of(case), case["author"].as_str().unwrap()).unwrap().1, "{}", case["name"]);
    }
}

#[test]
fn digests_are_the_sha256_of_the_utf8_body() {
    let dir = tempfile::tempdir().unwrap();
    let wb = workbook(dir.path());
    for case in cases()["digests"].as_array().unwrap() {
        let (stored, _, _) = wb.put_overview(case["markdown"].as_str().unwrap(), "ada").unwrap();
        assert_eq!(stored.digest, case["digest"].as_str().unwrap());
    }
}

#[test]
fn warnings_match_the_shared_vectors() {
    let cases = cases();
    let known: Vec<&str> = cases["investigations"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
    for case in cases["warnings"].as_array().unwrap() {
        let want: Vec<OverviewWarning> = serde_json::from_value(case["warnings"].clone()).unwrap();
        let got = check_overview(case["markdown"].as_str().unwrap(), &known);
        assert_eq!(got, want, "{}", case["name"]);
        assert_eq!(serde_json::to_value(&got).unwrap(), case["warnings"], "{}: JSON shape", case["name"]);
    }
}

#[test]
fn a_write_warns_about_its_own_workbook_and_still_stores_the_body() {
    let dir = tempfile::tempdir().unwrap();
    let wb = workbook(dir.path());
    let inv = with_investigation(&wb);
    let md = format!(
        "<ap-investigation investigation=\"{inv}\" hue=\"1\"></ap-investigation>\n\n<ap-investigation investigation=\"inv_gone\"></ap-investigation>\n"
    );
    let (stored, changed, warnings) = wb.put_overview(&md, "ada").unwrap();
    assert!(changed && stored.markdown == md);
    let codes: Vec<_> = warnings.iter().map(|w| (w.code.as_str(), w.attribute.as_deref(), w.investigation.as_deref())).collect();
    assert_eq!(codes, vec![("unknown_attribute", Some("hue"), None), ("unknown_investigation", None, Some("inv_gone"))]);
    // An unchanged write reports the same warnings.
    assert_eq!(wb.put_overview(&md, "ada").unwrap().2, warnings);
}

#[test]
fn newer_formats_are_refused_on_open_and_on_write() {
    let dir = tempfile::tempdir().unwrap();
    let wb = workbook(dir.path());
    Connection::open(wb.path()).unwrap().pragma_update(None, "user_version", 4).unwrap();
    let err = wb.put_overview("# x\n", "ada").unwrap_err();
    assert!(err.to_string().contains("format 4; this library reads up to 3"), "{err}");
    let (version, tables) = raw(wb.path());
    assert_eq!(version, 4, "not downgraded");
    assert!(!tables.contains_key("overviews"));
    let err = connect(Some(wb.path().to_str().unwrap())).unwrap().project("toy").unwrap_err();
    assert!(matches!(err, Error::Format(_)) && err.to_string().contains("format 4"), "{err}");
}

/// A workbook format 2 (display) or 3 (overview) is refused by a reader
/// that reads up to 2 exactly when it holds an overview: the check an SDK
/// before format 3 runs on open.
#[test]
fn only_an_overview_write_makes_a_workbook_unreadable_below_format_3() {
    let reads_up_to_2 = |path: &Path| raw(path).0 <= 2;
    let dir = tempfile::tempdir().unwrap();
    let wb = workbook(dir.path());
    wb.put_display(&manifest()).unwrap();
    wb.overview().unwrap();
    assert!(reads_up_to_2(wb.path()));
    wb.put_overview("# x\n", "ada").unwrap();
    assert!(!reads_up_to_2(wb.path()));
}

// --- cross-SDK goldens -----------------------------------------------------

/// What a reader must find in an overview golden.
fn expected(path: &Path, wb: &Workbook) -> Value {
    let (version, tables) = raw(path);
    json!({
        "format": {"user_version": version},
        "project": wb.name(),
        "investigations": wb.investigations().unwrap().into_iter().map(|i| i.id).collect::<Vec<_>>(),
        "overview_sql": tables["overviews"],
        "versions": wb.overview_versions().unwrap(),
    })
}

/// The Rust golden: two versions by two authors, the second non-ASCII and
/// naming the workbook's investigation, then a display write.
fn write_golden(path: &Path) -> Value {
    for p in [path.to_path_buf(), path.with_extension("ap-workbook-wal"), path.with_extension("ap-workbook-shm")] {
        let _ = std::fs::remove_file(p);
    }
    let exp = {
        let wb = connect(Some(path.to_str().unwrap())).unwrap().ensure_project("overview").unwrap().0;
        let inv = with_investigation(&wb);
        wb.put_overview("# Overview\n\nA first draft.\n", "rust-writer").unwrap();
        let md = format!(
            "# Overview — Temp\u{e9}rature \u{1f525}\n\n<ap-investigation investigation=\"{inv}\" title=\"Fit\"></ap-investigation>\n"
        );
        assert!(wb.put_overview(&md, "rust-reviewer").unwrap().2.is_empty());
        wb.put_display(&manifest()).unwrap();
        expected(path, &wb)
    };
    let raw = Connection::open(path).unwrap();
    let _: String = raw.query_row("PRAGMA journal_mode = DELETE", [], |r| r.get(0)).unwrap();
    raw.execute_batch("VACUUM").unwrap();
    exp
}

fn read_golden(golden: &Path) {
    let name = golden.file_name().unwrap().to_string_lossy().to_string();
    let exp: Value = serde_json::from_str(&std::fs::read_to_string(golden.with_extension("json")).unwrap()).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let copy = dir.path().join(golden.file_name().unwrap());
    std::fs::copy(golden, &copy).unwrap();
    let wb = connect(Some(copy.to_str().unwrap())).unwrap().workbooks().unwrap().remove(0);
    assert_eq!(expected(&copy, &wb), exp, "{name}");
    assert_eq!(exp["format"]["user_version"], 3, "{name}");
    assert_eq!(exp["overview_sql"], cases()["sql"], "{name}");
    let versions: Vec<autophys::StoredOverview> = serde_json::from_value(exp["versions"].clone()).unwrap();
    assert!(versions.len() >= 2, "{name}");
    for v in &versions {
        assert_eq!(v.digest, sha256_hex([v.markdown.as_bytes()]), "{name}");
    }
    let latest = versions.last().unwrap().clone();
    assert_eq!(wb.overview().unwrap(), Some(latest.clone()), "{name}");
    assert!(wb.verify().unwrap().ok, "{name}");
    let known: Vec<String> = wb.investigations().unwrap().into_iter().map(|i| i.id).collect();
    assert!(check_overview(&latest.markdown, &known).is_empty(), "{name}");
    let (same, changed, _) = wb.put_overview(&latest.markdown, "reader").unwrap();
    assert!(!changed && same == latest, "{name}: rewriting the latest adds no row");
    wb.put_display(&manifest()).unwrap();
    assert_eq!(raw(&copy).0, 3, "{name}");
}

#[test]
fn overview_goldens_read_back() {
    let dir = shared();
    let mut goldens: Vec<PathBuf> = std::fs::read_dir(&dir)
        .unwrap()
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "ap-workbook"))
        .collect();
    goldens.sort();
    let names: Vec<String> = goldens.iter().map(|p| p.file_stem().unwrap().to_string_lossy().into()).collect();
    assert!(names.iter().any(|n| n == "rust"), "{names:?}");
    for golden in goldens {
        read_golden(&golden);
    }
}

/// `AUTOPHYS_WRITE_GOLDENS=1` rewrites `tests/conformance/overview/rust.*`;
/// otherwise the generator writes a temporary golden and reads it back.
#[test]
fn the_overview_generator_writes_a_self_consistent_golden() {
    let target = if std::env::var_os("AUTOPHYS_WRITE_GOLDENS").is_some() {
        None
    } else {
        Some(tempfile::tempdir().unwrap())
    };
    let path = match &target {
        Some(dir) => dir.path().join("rust.ap-workbook"),
        None => shared().join("rust.ap-workbook"),
    };
    let exp = write_golden(&path);
    std::fs::write(path.with_extension("json"), serde_json::to_string_pretty(&exp).unwrap() + "\n").unwrap();
    read_golden(&path);
}
