//! The public API on real files: connect targets, the workbook format, the
//! append rules (replay, conflicts, transitions, `edited` limits), the
//! approval verbs, `wait_for_approval` across connections, and verify.

use std::time::Duration;

use autophys::{APPLICATION_ID, Error, FORMAT_VERSION, Workbook, connect, sha256_hex, slug};
use rusqlite::Connection;
use serde_json::{Value, json};

const CONFIG: &[u8] = br#"{"name":"thermal","x":1.5}"#;

fn version() -> String {
    format!("sha256:{}", sha256_hex([CONFIG]))
}

/// A collection in a temp dir with project `thermal` and its config stored.
fn seeded() -> (tempfile::TempDir, Workbook) {
    let dir = tempfile::tempdir().unwrap();
    let client = connect(Some(dir.path().to_str().unwrap())).unwrap();
    let wb = client.ensure_project("thermal").unwrap().0;
    assert!(wb.put_config_version(&version(), CONFIG).unwrap());
    (dir, wb)
}

fn proposed(pid: &str) -> Value {
    json!({"proposal_id": pid, "event": "proposed", "experiment": "sine", "settings": {"f": 0.44}})
}

fn code(e: &Error) -> (u16, &str) {
    (e.status(), e.code())
}

#[test]
fn connect_takes_local_paths_and_remote_urls() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let client = connect(Some(root)).unwrap();
    assert!(
        client.projects().unwrap().is_empty(),
        "a missing collection is empty"
    );
    let wb = client.ensure_project("Heated Block!").unwrap().0;
    assert_eq!(wb.path(), dir.path().join("heated-block.ap-workbook"));
    assert_eq!(wb.name(), "Heated Block!");
    assert!(wb.id().starts_with("prj_") && wb.id().len() == 20);

    let projects = client.projects().unwrap();
    assert_eq!(projects.len(), 1);
    assert_eq!(projects[0].id, wb.id());
    assert_eq!(
        client.project_by_id(wb.id()).unwrap().name(),
        "Heated Block!"
    );

    let file = format!("{root}/heated-block.ap-workbook");
    let one = connect(Some(&file)).unwrap();
    assert_eq!(one.projects().unwrap()[0].id, wb.id());
    assert_eq!(one.project("Heated Block!").unwrap().id(), wb.id());

    for url in ["http://127.0.0.1:4794", "https://gb10.example/autophys"] {
        let remote = autophys::Client::connect_remote(url, "test-key").unwrap();
        assert!(remote.remote().is_some());
        assert_eq!(remote.remote().unwrap().base(), format!("{url}/api/v1"));
    }
}

#[test]
fn slugs_follow_the_format_spec() {
    assert_eq!(slug("heated-block"), "heated-block");
    assert_eq!(slug("Heated Block"), "heated-block");
    assert_eq!(slug("  a//b..c  "), "a-b..c");
    assert_eq!(slug("..-x-.."), "x");
    assert_eq!(slug("é"), "project");
    assert_eq!(slug("v1.2_rc"), "v1.2_rc");
}

#[test]
fn a_workbook_file_is_format_1_with_one_project_and_no_server_tables() {
    let (dir, wb) = seeded();
    let raw = Connection::open(wb.path()).unwrap();
    let pragma = |n: &str| -> i64 {
        raw.query_row(&format!("PRAGMA {n}"), [], |r| r.get(0))
            .unwrap()
    };
    assert_eq!(pragma("application_id"), APPLICATION_ID);
    assert_eq!(APPLICATION_ID, 0x41505742);
    assert_eq!(pragma("user_version"), FORMAT_VERSION);
    assert_eq!(FORMAT_VERSION, 1);
    let mode: String = raw
        .query_row("PRAGMA journal_mode", [], |r| r.get(0))
        .unwrap();
    assert_eq!(mode, "wal");
    let mut stmt = raw
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .unwrap();
    let tables: Vec<String> = stmt
        .query_map([], |r| r.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert_eq!(
        tables,
        [
            "blobs",
            "config_versions",
            "investigations",
            "projects",
            "proposals",
            "records"
        ]
    );
    let projects: i64 = raw
        .query_row("SELECT count(*) FROM projects", [], |r| r.get(0))
        .unwrap();
    assert_eq!(projects, 1);

    // A slug collision with another name is refused; the same name reopens.
    let client = connect(Some(dir.path().to_str().unwrap())).unwrap();
    let err = client.project("THERMAL").unwrap_err();
    assert_eq!(code(&err), (409, "conflict"));
    let fresh = connect(Some(dir.path().to_str().unwrap())).unwrap();
    assert_eq!(fresh.project("thermal").unwrap().id(), wb.id());
    let err = fresh.project("Thermal").unwrap_err();
    assert_eq!(code(&err), (409, "conflict"));
}

#[test]
fn project_by_name_opens_and_only_ensure_project_creates() {
    // CORE-04: a missing project is 404 and writes nothing, locally and in
    // single-file mode; ensure_project creates once, then project opens it.
    let dir = tempfile::tempdir().unwrap();
    let client = connect(Some(dir.path().to_str().unwrap())).unwrap();
    let err = client.project("thermal").unwrap_err();
    assert_eq!(code(&err), (404, "not_found"));
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    let file = dir.path().join("solo.ap-workbook");
    let solo = connect(Some(file.to_str().unwrap())).unwrap();
    assert_eq!(code(&solo.project("solo").unwrap_err()), (404, "not_found"));
    assert!(!file.exists());
    let (wb, created) = client.ensure_project("thermal").unwrap();
    assert!(created);
    assert!(!client.ensure_project("thermal").unwrap().1);
    assert_eq!(client.project("thermal").unwrap().id(), wb.id());
    let reopened = connect(Some(dir.path().to_str().unwrap())).unwrap();
    assert_eq!(reopened.project("thermal").unwrap().id(), wb.id());
    assert_eq!(code(&reopened.project("other").unwrap_err()), (404, "not_found"));
    assert!(client.project(" ").is_err());
}

#[test]
fn foreign_and_newer_files_are_refused() {
    let dir = tempfile::tempdir().unwrap();
    let other = dir.path().join("other.ap-workbook");
    Connection::open(&other)
        .unwrap()
        .execute_batch("CREATE TABLE t (x)")
        .unwrap();
    let client = connect(Some(dir.path().to_str().unwrap())).unwrap();
    let err = client.projects().unwrap_err();
    assert!(matches!(err, Error::Format(_)), "{err}");

    let newer = tempfile::tempdir().unwrap();
    let path = newer.path().join("x.ap-workbook");
    let c = Connection::open(&path).unwrap();
    c.pragma_update(None, "application_id", APPLICATION_ID)
        .unwrap();
    c.pragma_update(None, "user_version", 2).unwrap();
    drop(c);
    let err = connect(Some(path.to_str().unwrap()))
        .unwrap()
        .project("x")
        .unwrap_err();
    assert!(err.to_string().contains("format 2"), "{err}");
}

#[test]
fn config_versions_must_hash_to_their_body() {
    let (_dir, wb) = seeded();
    assert!(
        !wb.put_config_version(&version(), CONFIG).unwrap(),
        "re-put is a no-op"
    );
    let err = wb.put_config_version("sha256:00", CONFIG).unwrap_err();
    assert_eq!(code(&err), (422, "hash_mismatch"));
    let bad = b"not json";
    let err = wb
        .put_config_version(&format!("sha256:{}", sha256_hex([&bad[..]])), bad)
        .unwrap_err();
    assert_eq!(code(&err), (422, "invalid_payload"));
    let versions = wb.config_versions().unwrap();
    assert_eq!(versions.len(), 1);
    assert_eq!(versions[0].config["x"], 1.5);
}

#[test]
fn create_investigation_pins_a_stored_config_and_replays_by_record_id() {
    let (_dir, wb) = seeded();
    let meta = json!({"config_version": version(), "overrides": {"free": ["C"]}, "name": "t"});
    let (inv, new) = wb
        .create_investigation(meta.clone(), Some("key-1"))
        .unwrap();
    assert!(new && inv.id.starts_with("inv_") && inv.id.len() == 20);
    let (again, new) = wb
        .create_investigation(meta.clone(), Some("key-1"))
        .unwrap();
    assert!(!new);
    assert_eq!(again.id, inv.id);
    let err = wb
        .create_investigation(json!({"config_version": version()}), Some("key-1"))
        .unwrap_err();
    assert_eq!(code(&err), (409, "idempotency_conflict"));
    let err = wb
        .create_investigation(json!({"config_version": "sha256:ff"}), None)
        .unwrap_err();
    assert_eq!(code(&err), (409, "unknown_config_version"));
    let err = wb
        .create_investigation(
            json!({"project_id": "prj_0000000000000000", "config_version": version()}),
            None,
        )
        .unwrap_err();
    assert_eq!(code(&err), (404, "not_found"));

    let head = &inv.records(None).unwrap()[0];
    assert_eq!((head.seq, head.kind.as_str()), (0, "investigation"));
    assert_eq!(head.payload["project_id"], wb.id());
    assert_eq!(head.payload["overrides"], json!({"free": ["C"]}));
    assert_eq!(head.prev_hash, autophys::GENESIS);
    let info = inv.info().unwrap();
    assert_eq!((info.status.as_str(), info.budget_used), ("open", 0));
    assert_eq!(wb.investigations().unwrap().len(), 1);
}

#[test]
fn appends_replay_refuse_reused_ids_and_chain() {
    let (_dir, wb) = seeded();
    let (inv, _) = wb
        .create_investigation(json!({"config_version": version()}), None)
        .unwrap();
    let m = json!({"version": 1, "observation": {"t": [0.0, 1.0]}});
    let a = inv.append("measurement", m.clone(), Some("m-1")).unwrap();
    assert!(a.created);
    assert_eq!((a.record.seq, a.gseq), (1, 2));
    let replay = inv.append("measurement", m.clone(), Some("m-1")).unwrap();
    assert!(!replay.created);
    assert_eq!(replay.record, a.record);
    assert_eq!(replay.gseq, a.gseq);
    let err = inv
        .append("measurement", json!({"observation": {}}), Some("m-1"))
        .unwrap_err();
    assert_eq!(code(&err), (409, "idempotency_conflict"));
    let err = inv.append("run", json!({}), Some("m-1")).unwrap_err();
    assert_eq!(code(&err), (409, "idempotency_conflict"));

    let err = inv.append("measurement", json!({}), None).unwrap_err();
    assert_eq!(code(&err), (422, "invalid_payload"));
    let err = inv.append("bogus", json!({}), None).unwrap_err();
    assert_eq!(code(&err), (422, "invalid_payload"));
    let err = inv.append("investigation", json!({}), None).unwrap_err();
    assert_eq!(code(&err), (400, "invalid_request"));
    let err = inv.append("run", json!({}), Some("bad id")).unwrap_err();
    assert_eq!(code(&err), (422, "invalid_payload"));
    let big = json!({"blob": "x".repeat(autophys::MAX_PAYLOAD_BYTES)});
    let err = inv.append("run", big, None).unwrap_err();
    assert_eq!(code(&err), (413, "payload_too_large"));

    let r = inv.append("run", json!({"loss": 0.5}), None).unwrap();
    assert_eq!(r.record.prev_hash, a.record.hash);
    assert_eq!(r.record.id.len(), 32, "a generated id is 32 hex");
    let after = inv.records_after(a.gseq).unwrap();
    assert_eq!(after.len(), 1);
    assert_eq!(after[0].record.id, r.record.id);
    assert_eq!(inv.records(Some("measurement")).unwrap().len(), 1);
    assert_eq!(
        code(&inv.records(Some("nope")).unwrap_err()),
        (422, "invalid_payload")
    );
    assert_eq!(inv.info().unwrap().budget_used, 1);
    assert_eq!(wb.cursor().unwrap(), r.gseq);
    assert_eq!(wb.records_after(0, 100).unwrap().len(), 3);
    let s = serde_json::to_value(&r).unwrap();
    assert_eq!(s["gseq"], r.gseq);
    assert_eq!(s["record"]["id"], r.record.id.as_str());
    assert!(s.get("created").is_none(), "{s}");
}

#[test]
fn the_proposal_state_machine_and_the_approval_verbs() {
    let (_dir, wb) = seeded();
    let (inv, _) = wb
        .create_investigation(json!({"config_version": version()}), None)
        .unwrap();
    assert_eq!(
        code(&inv.approve("p-1", "james", None).unwrap_err()),
        (404, "not_found")
    );
    inv.append("proposal", proposed("p-1"), Some("p-1.proposed"))
        .unwrap();
    assert_eq!(inv.info().unwrap().status, "awaiting_approval");
    let err = inv
        .append("proposal", proposed("p-1"), Some("p-1.again"))
        .unwrap_err();
    assert_eq!(code(&err), (409, "proposal_exists"));
    let err = inv
        .append(
            "proposal",
            json!({"proposal_id": "p-1", "event": "data_attached", "measurement_version": 1}),
            None,
        )
        .unwrap_err();
    assert_eq!(code(&err), (409, "conflict"));

    let ok = inv.approve("p-1", "james", None).unwrap();
    assert_eq!(ok.record.payload["event"], "approved");
    assert_eq!(ok.record.payload["by"], "james");
    let p = inv.proposal("p-1").unwrap();
    assert_eq!(
        (p.status.as_str(), p.experiment.as_deref()),
        ("approved", Some("sine"))
    );
    assert_eq!(inv.info().unwrap().status, "awaiting_data");
    assert_eq!(
        code(&inv.reject("p-1", "james", "late").unwrap_err()),
        (409, "conflict")
    );

    let attached = inv
        .attach_data("p-1", json!({"t": [0.0], "y": {"x": [1.0]}}))
        .unwrap();
    assert_eq!(attached.record.payload["event"], "data_attached");
    let measurement = &inv.records(Some("measurement")).unwrap()[0];
    assert_eq!(
        attached.record.payload["measurement_version"],
        measurement.hash.as_str()
    );
    assert_eq!(inv.proposal("p-1").unwrap().status, "data_attached");
    assert_eq!(inv.info().unwrap().status, "open");
    assert_eq!(inv.info().unwrap().budget_used, 1);
    assert_eq!(
        code(&inv.attach_data("p-1", json!({})).unwrap_err()),
        (409, "conflict")
    );

    inv.append("proposal", proposed("p-2"), None).unwrap();
    let r = inv.reject("p-2", "james", "too long").unwrap();
    assert_eq!(r.record.payload["reason"], "too long");
    assert_eq!(inv.proposal("p-2").unwrap().status, "rejected");
    inv.append("proposal", proposed("p-3"), None).unwrap();
    inv.append(
        "proposal",
        json!({"proposal_id": "p-3", "event": "withdrawn"}),
        None,
    )
    .unwrap();
    assert_eq!(inv.proposal("p-3").unwrap().status, "withdrawn");
    assert_eq!(code(&inv.proposal("p-9").unwrap_err()), (404, "not_found"));
    assert_eq!(wb.proposals().unwrap().len(), 3);
    inv.append("outcome", json!({"status": "validated"}), None)
        .unwrap();
    assert_eq!(inv.info().unwrap().status, "validated");
    assert!(wb.verify().unwrap().ok);
}

#[test]
fn an_edit_may_only_move_outlook_axes_within_their_range() {
    let (_dir, wb) = seeded();
    let (inv, _) = wb
        .create_investigation(json!({"config_version": version()}), None)
        .unwrap();
    let mut p = proposed("p-1");
    p["settings"] = json!({"freq": 0.44, "kind": "sine"});
    p["outlook"] = json!({"axes": [{"name": "freq", "values": [0.1, 2.0]}], "score": [1, 2], "after": {"C": [3, 4]}});
    inv.append("proposal", p, None).unwrap();
    for (settings, path) in [
        (json!({"freq": 2.5}), "payload.settings.freq"),
        (json!({"freq": "fast"}), "payload.settings.freq"),
        (
            json!({"freq": 1.0, "kind": "square"}),
            "payload.settings.kind",
        ),
        (json!({"amp": 1}), "payload.settings.amp"),
    ] {
        match inv.approve("p-1", "james", Some(settings)).unwrap_err() {
            Error::Invalid { path: at, .. } => assert_eq!(at, path),
            other => panic!("{other}"),
        }
    }
    let edited = inv
        .approve("p-1", "james", Some(json!({"freq": 2.0, "kind": "sine"})))
        .unwrap();
    assert_eq!(edited.record.payload["event"], "edited");
    let p = inv.proposal("p-1").unwrap();
    assert_eq!(p.status, "edited");
    assert_eq!(p.settings, Some(json!({"freq": 2.0, "kind": "sine"})));
}

#[test]
fn wait_for_approval_sees_a_decision_from_another_connection() {
    let (dir, wb) = seeded();
    let (inv, _) = wb
        .create_investigation(json!({"config_version": version()}), None)
        .unwrap();
    assert_eq!(
        code(&
            inv.wait_for_approval("p-1", Duration::from_millis(10))
                .unwrap_err()
        ),
        (404, "not_found")
    );
    inv.append("proposal", proposed("p-1"), None).unwrap();
    let err = inv
        .wait_for_approval("p-1", Duration::from_millis(150))
        .unwrap_err();
    assert!(matches!(err, Error::Timeout(_)), "{err}");

    // A second client (as another process would) decides after a delay.
    let root = dir.path().to_str().unwrap().to_string();
    let id = inv.id.clone();
    let decider = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(200));
        let other = connect(Some(&root)).unwrap();
        other
            .find_investigation(&id)
            .unwrap()
            .reject("p-1", "browser", "no")
            .unwrap();
    });
    let p = inv
        .wait_for_approval("p-1", Duration::from_secs(5))
        .unwrap();
    assert_eq!(p.status, "rejected");
    decider.join().unwrap();
}

#[test]
fn verify_finds_drift_and_tampering_and_rebuild_repairs_projections() {
    let (_dir, wb) = seeded();
    for n in 0..3 {
        let (inv, _) = wb
            .create_investigation(json!({"config_version": version(), "n": n}), None)
            .unwrap();
        inv.append("measurement", json!({"observation": {"n": n}}), None)
            .unwrap();
        inv.append("run", json!({"loss": 0.5}), Some(&format!("r-{n}")))
            .unwrap();
        inv.append("proposal", proposed("p"), None).unwrap();
    }
    let report = wb.verify().unwrap();
    assert!(report.ok && report.projections_match, "{report:?}");
    assert_eq!((report.records, report.investigations), (12, 3));
    let before = wb.projection_rows().unwrap();
    assert_eq!(wb.heads().unwrap().len(), 3);

    let raw = Connection::open(wb.path()).unwrap();
    assert!(
        raw.execute("UPDATE records SET payload = '{}' WHERE gseq = 2", [])
            .is_err()
    );
    assert!(
        raw.execute("DELETE FROM records WHERE gseq = 2", [])
            .is_err()
    );
    raw.execute_batch("UPDATE investigations SET status = 'bogus'; DELETE FROM proposals;")
        .unwrap();
    let report = wb.verify().unwrap();
    assert!(!report.ok && !report.projections_match && report.chain_errors.is_empty());
    let report = wb.rebuild_projections().unwrap();
    assert!(report.ok, "{report:?}");
    assert_eq!(wb.projection_rows().unwrap(), before);

    raw.execute_batch(
        "DROP TRIGGER records_no_update;
         UPDATE records SET payload = '{\"loss\":0.25}' WHERE id LIKE 'r-%';",
    )
    .unwrap();
    let report = wb.verify().unwrap();
    assert_eq!(report.chain_errors.len(), 3, "{report:?}");
    assert!(
        report
            .chain_errors
            .iter()
            .all(|e| e.problem.starts_with("hash does not match"))
    );
    assert!(!report.ok);
}

#[test]
fn a_snapshot_is_the_whole_workbook_at_one_cursor() {
    let (_dir, wb) = seeded();
    let (inv, _) = wb
        .create_investigation(json!({"config_version": version()}), None)
        .unwrap();
    inv.append("proposal", proposed("p-1"), None).unwrap();
    let snap = wb.snapshot().unwrap();
    assert_eq!(snap.cursor, 2);
    assert_eq!(snap.project.id, wb.id());
    assert_eq!(
        (
            snap.records.len(),
            snap.investigations.len(),
            snap.proposals.len()
        ),
        (2, 1, 1)
    );
    assert_eq!(snap.config_versions[0].version, version());
}

#[test]
fn rejects_multiple_project_rows_and_invalid_names_without_poisoning_the_collection() {
    let dir = tempfile::tempdir().unwrap();
    let client = connect(Some(dir.path().to_str().unwrap())).unwrap();
    assert!(client.project(" ").is_err());
    assert!(client.projects().unwrap().is_empty());
    let wb = client.ensure_project("thermal").unwrap().0;
    let path = wb.path().to_path_buf();
    let raw = Connection::open(&path).unwrap();
    raw.execute(
        "INSERT INTO projects VALUES ('prj_0000000000000000', 'other', 0)",
        [],
    )
    .unwrap();
    drop(raw);
    drop(wb);
    drop(client);
    let client = connect(Some(dir.path().to_str().unwrap())).unwrap();
    assert!(matches!(client.projects().unwrap_err(), Error::Format(_)));
}

#[test]
fn concurrent_data_attachments_commit_exactly_one_measurement_and_event() {
    let (_dir, wb) = seeded();
    let (inv, _) = wb
        .create_investigation(json!({"config_version": version()}), None)
        .unwrap();
    inv.append("proposal", proposed("data-race"), None).unwrap();
    inv.approve("data-race", "test", None).unwrap();
    let other = connect(Some(wb.path().to_str().unwrap()))
        .unwrap()
        .project("thermal")
        .unwrap()
        .investigation(&inv.id)
        .unwrap();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let start = barrier.clone();
    let worker = std::thread::spawn(move || {
        start.wait();
        other.attach_data("data-race", json!({"source": "other"}))
    });
    barrier.wait();
    let a = inv.attach_data("data-race", json!({"source": "here"}));
    let b = worker.join().unwrap();
    assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
    let error = a.err().or_else(|| b.err()).unwrap();
    assert_eq!(code(&error), (409, "conflict"));
    let measurements = inv.records(Some("measurement")).unwrap();
    assert_eq!(measurements.len(), 1);
    let events = inv.records(Some("proposal")).unwrap();
    assert_eq!(
        events.last().unwrap().payload["measurement_version"],
        measurements[0].hash
    );
    assert!(wb.verify().unwrap().ok);
}

#[test]
fn repeated_outlook_axis_names_use_the_last_range_as_python_does() {
    let (_dir, wb) = seeded();
    let (inv, _) = wb
        .create_investigation(json!({"config_version": version()}), None)
        .unwrap();
    inv.append(
        "proposal",
        json!({
            "proposal_id": "duplicate-axis", "event": "proposed", "experiment": "sine",
            "settings": {"f": 5},
            "outlook": {"axes": [{"name": "f", "values": [0, 1]}, {"name": "f", "values": [5, 6]}],
                        "score": [1, 2, 3, 4], "after": {}}
        }),
        None,
    )
    .unwrap();
    assert_eq!(
        code(&
            inv.approve("duplicate-axis", "test", Some(json!({"f": 0.5})))
                .unwrap_err()
        ),
        (422, "invalid_payload")
    );
    inv.approve("duplicate-axis", "test", Some(json!({"f": 5.5})))
        .unwrap();
}
