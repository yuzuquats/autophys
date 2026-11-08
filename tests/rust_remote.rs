//! Conformance through the real autophys-cli binary built by this workspace.
//! No fake daemon, provider call, installed service or shared data is used.
use autophys::{Client, Error, Workbook, blocking::auth, canonical};
use autophys_cli::keys::KeyStore;
use serde_json::json;
use std::{
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

struct Daemon {
    child: Child,
    dir: tempfile::TempDir,
    url: String,
    keys: KeyStore,
    key: String,
    key_id: String,
}
impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
impl Daemon {
    fn start() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let web = dir.path().join("web");
        std::fs::create_dir_all(web.join("routes")).unwrap();
        std::fs::write(
            web.join("routes/index.anon.html"),
            "<!doctype html><title>Remote conformance</title>",
        )
        .unwrap();
        let db = dir.path().join("server.db");
        let keys = KeyStore::open(&db).unwrap();
        let pair = keys.pair_start("bootstrap", "autophys-rust-test").unwrap();
        keys.pair_approve(&pair.user_code).unwrap();
        let issued = keys.pair_poll(&pair.device_code).unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        drop(listener);
        let child = Command::new(env!("CARGO_BIN_EXE_autophys"))
            .args(["serve", "--addr", &addr.to_string(), "--web-root"])
            .arg(&web)
            .arg("--collection")
            .arg(dir.path().join("collection"))
            .arg("--server-db")
            .arg(&db)
            .env_remove("AUTOPHYS_LOGIN")
            .env_remove("AUTOPHYS_PUBLIC_URL")
            .env_remove("AUTOPHYS_BROWSER_ORIGINS")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let d = Self {
            child,
            dir,
            url: format!("http://{addr}"),
            keys,
            key: issued.api_key,
            key_id: issued.key_id,
        };
        let client = d.client();
        let start = Instant::now();
        while client.projects().is_err() {
            assert!(
                start.elapsed() < Duration::from_secs(15),
                "daemon failed to start"
            );
            std::thread::sleep(Duration::from_millis(30));
        }
        d
    }
    fn client(&self) -> Client {
        Client::connect_remote(&self.url, &self.key).unwrap()
    }
    fn workbook(&self, name: &str) -> (Workbook, String) {
        let wb = self.client().ensure_project(name).unwrap().0;
        let config = canonical(&json!({"name":name,"x":1.5,"unicode":"é"}));
        let ver = format!("sha256:{}", autophys::sha256_hex([config.as_bytes()]));
        assert!(wb.put_config_version(&ver, config.as_bytes()).unwrap());
        assert!(!wb.put_config_version(&ver, config.as_bytes()).unwrap());
        (wb, ver)
    }
}
fn http(e: Error, status: u16, code: &str) -> autophys::HttpError {
    assert_eq!(e.status(), status);
    assert_eq!(e.code(), code);
    match e {
        Error::Http(h) => {
            assert_eq!(h.status, status);
            assert_eq!(h.error, code);
            *h
        }
        other => panic!("expected wire error, got {other:?}"),
    }
}
#[test]
fn auth_pairing_and_credential_discovery_against_daemon() {
    let d = Daemon::start();
    let bad = Client::connect_remote(&d.url, "apk_wrong").unwrap();
    let e = http(bad.project("x").unwrap_err(), 401, "unauthorized");
    assert!(e.is_auth());
    assert_eq!(e.message, "missing or unknown API key");
    assert!(!format!("{:?}", d.client()).contains(&d.key));

    let start = auth::pair_start(&d.url, "rust-device").unwrap();
    assert!(!format!("{start:?}").contains(&start.device_code));
    d.keys.pair_approve(&start.user_code).unwrap();
    let creds = auth::pair_poll(&d.url, &start, "rust-device").unwrap();
    let me = auth::whoami(&creds).unwrap();
    assert_eq!(me["device_name"], "rust-device");
    assert_eq!(me["workspace"], "local");
    http(
        auth::pair_poll(&d.url, &start, "rust-device").unwrap_err(),
        400,
        "expired_token",
    );

    let denied = auth::pair_start(&d.url, "denied").unwrap();
    d.keys.pair_deny(&denied.user_code).unwrap();
    let e = http(
        auth::pair_poll(&d.url, &denied, "denied").unwrap_err(),
        400,
        "access_denied",
    );
    assert!(!e.is_auth());
    let mut expired = auth::pair_start(&d.url, "expiry").unwrap();
    expired.expires_in = 0.0;
    let e = http(
        auth::pair_poll(&d.url, &expired, "expiry").unwrap_err(),
        400,
        "expired_token",
    );
    assert_eq!(e.message, "pairing code expired before approval");

    // Exercise connect's environment/file discovery in an isolated child
    // process via the real CLI; avoid unsafe process-wide environment edits.
    let cfg = d.dir.path().join("cfg");
    std::fs::create_dir(&cfg).unwrap();
    let path = cfg.join("credentials");
    std::fs::write(&path, serde_json::to_vec(&creds).unwrap()).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    let run = |key: Option<&str>| {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_autophys"));
        cmd.args(["projects", "--target", &d.url, "--json"])
            .env("AUTOPHYS_CONFIG_DIR", &cfg)
            .env_remove("AUTOPHYS_API_KEY");
        if let Some(key) = key {
            cmd.env("AUTOPHYS_API_KEY", key);
        }
        cmd.output().unwrap()
    };
    assert!(run(None).status.success());
    assert!(
        !run(Some("apk_wrong")).status.success(),
        "environment key must win"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        let out = run(Some(&d.key));
        assert!(!out.status.success());
        assert!(String::from_utf8_lossy(&out.stderr).contains("chmod 600"));
    }
    d.keys.keys_revoke(&d.key_id).unwrap();
    assert!(http(d.client().projects().unwrap_err(), 401, "unauthorized").is_auth());
}

#[test]
fn create_replay_conflict_and_record_contract() {
    let d = Daemon::start();
    let (wb, ver) = d.workbook("thermal");
    assert!(!d.client().ensure_project("thermal").unwrap().1);
    assert_eq!(wb.config_versions().unwrap()[0].version, ver);
    let meta = json!({"config_version":ver,"overrides":{"free":["C"]}});
    let (a, new) = wb
        .create_investigation(meta.clone(), Some("stable-create-key"))
        .unwrap();
    assert!(new);
    let (again, new) = wb
        .create_investigation(meta.clone(), Some("stable-create-key"))
        .unwrap();
    assert!(!new);
    assert_eq!(a.id, again.id);
    let err = http(
        wb.create_investigation(
            json!({"config_version":ver,"different":true}),
            Some("stable-create-key"),
        )
        .unwrap_err(),
        409,
        "idempotency_conflict",
    );
    assert!(err.message.contains("already used"));
    // Pins the intended Python fix: no key always means a fresh logical create.
    let (b, _) = wb.create_investigation(meta.clone(), None).unwrap();
    let (c, _) = wb.create_investigation(meta, None).unwrap();
    assert_ne!(a.id, b.id);
    assert_ne!(b.id, c.id);
    http(
        wb.create_investigation(json!({"config_version":"sha256:00"}), None)
            .unwrap_err(),
        409,
        "unknown_config_version",
    );
    http(
        wb.put_config_version("sha256:00", b"{}").unwrap_err(),
        422,
        "hash_mismatch",
    );
    let invalid = http(
        a.append("measurement", json!({"observation":3}), Some("bad"))
            .unwrap_err(),
        422,
        "invalid_payload",
    );
    assert_eq!(invalid.path.as_deref(), Some("payload.observation"));
    assert_eq!(Error::from(invalid).body()["path"], "payload.observation");
    let r1 = a.append("run", json!({"loss":1.0}), Some("abc")).unwrap();
    let r2 = a.append("run", json!({"loss":1.0}), Some("abc")).unwrap();
    assert!(r1.created);
    assert!(!r2.created);
    assert_eq!(r1.record, r2.record);
    assert_eq!(r1.gseq, r2.gseq);
    http(
        a.append("run", json!({"loss":2.0}), Some("abc"))
            .unwrap_err(),
        409,
        "idempotency_conflict",
    );
    a.append("step", json!({"decision":{"action":"inspect_data"}}), None)
        .unwrap();
    assert_eq!(a.records(Some("run")).unwrap().len(), 1);
    http(
        a.records(Some("bad kind")).unwrap_err(),
        422,
        "invalid_payload",
    );
    assert_eq!(a.records(None).unwrap()[0].seq, 0);
    assert_eq!(d.client().find_investigation(&a.id).unwrap().id, a.id);
    assert_eq!(d.client().investigations().unwrap().len(), 3);
    let filtered = a.records_after(r1.gseq).unwrap();
    assert_eq!(filtered.len(), 1);
    assert_eq!(filtered[0].record.kind, "step");
    let snap = wb.snapshot().unwrap();
    assert_eq!(wb.records_after(0, 100).unwrap().len(), snap.records.len());
    assert!(wb.verify().unwrap().ok);
    assert_eq!(wb.heads().unwrap()[&a.id].seq, 2);
}

#[test]
fn proposals_stream_wait_measurements_reveal_display_and_blobs() {
    let d = Daemon::start();
    let (wb, ver) = d.workbook("p");
    let (inv, _) = wb
        .create_investigation(json!({"config_version":ver}), None)
        .unwrap();
    let propose = |pid: &str| {
        inv.append("proposal",json!({"proposal_id":pid,"event":"proposed","experiment":"e","settings":{"power":1.0},"outlook":{"axes":[{"name":"power","values":[1,2]}],"score":[0,1],"after":{}}}),None).unwrap()
    };
    propose("p1");
    let head = wb.remote().unwrap().cursor(&inv.id);
    let decided = inv.clone();
    let writer = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(150));
        decided.approve("p1", "rust", None).unwrap()
    });
    assert_eq!(
        inv.wait_for_approval("p1", Duration::from_secs(3))
            .unwrap()
            .status,
        "approved"
    );
    writer.join().unwrap();
    assert_eq!(wb.remote().unwrap().last_wait(), Some("stream"));
    assert!(wb.remote().unwrap().cursor(&inv.id) > head);
    let attached = inv
        .attach_data(
            "p1",
            json!({"experiment":"e","t":[0.0],"y":{"temp":[20.0]}}),
        )
        .unwrap();
    assert_eq!(attached.record.payload["event"], "data_attached");
    assert_eq!(inv.records(Some("measurement")).unwrap().len(), 1);
    let replay = inv
        .attach_data(
            "p1",
            json!({"experiment":"e","t":[0.0],"y":{"temp":[20.0]}}),
        )
        .unwrap();
    assert!(!replay.created);
    assert_eq!(inv.records(Some("measurement")).unwrap().len(), 1);
    propose("p2");
    let before = inv.records(None).unwrap().len();
    assert!(inv.attach_data("p2", json!({"t":[]})).is_err());
    assert_eq!(inv.records(None).unwrap().len(), before);
    let err = http(
        inv.approve("p2", "rust", Some(json!({"power":3.0})))
            .unwrap_err(),
        422,
        "invalid_payload",
    );
    assert_eq!(err.path.as_deref(), Some("payload.settings.power"));
    inv.approve("p2", "rust", Some(json!({"power":1.5})))
        .unwrap();
    assert_eq!(
        inv.wait_for_approval("p2", Duration::from_secs(1))
            .unwrap()
            .settings,
        Some(json!({"power":1.5}))
    );
    propose("p3");
    inv.reject("p3", "rust", "no").unwrap();
    assert_eq!(
        wb.remote()
            .unwrap()
            .wait_for_approval_with(
                &inv.id,
                "p3",
                Duration::from_secs(1),
                Duration::from_millis(10),
                false
            )
            .unwrap()
            .status,
        "rejected"
    );
    propose("p4");
    inv.append(
        "proposal",
        json!({"proposal_id":"p4","event":"withdrawn"}),
        None,
    )
    .unwrap();
    assert_eq!(inv.proposal("p4").unwrap().status, "withdrawn");
    propose("p5");
    let start = Instant::now();
    assert!(matches!(
        inv.wait_for_approval("p5", Duration::from_millis(120)),
        Err(Error::Timeout(_))
    ));
    assert!(start.elapsed() < Duration::from_secs(1));
    http(
        inv.wait_for_approval("missing", Duration::from_secs(1))
            .unwrap_err(),
        404,
        "not_found",
    );
    http(
        inv.append("reveal", json!({"truth":{}}), Some("reveal"))
            .unwrap_err(),
        409,
        "outcome_required",
    );
    inv.append("outcome", json!({"status":"validated"}), None)
        .unwrap();
    assert!(
        inv.append("reveal", json!({"truth":{}}), Some("reveal"))
            .unwrap()
            .created
    );
    assert!(
        !inv.append("reveal", json!({"truth":{}}), Some("reveal"))
            .unwrap()
            .created
    );
    http(
        inv.append("reveal", json!({"truth":{}}), Some("second"))
            .unwrap_err(),
        409,
        "already_revealed",
    );
    let body = br#"{"format":1,"channels":{"temp":{"role":"output"}}}"#;
    assert!(wb.put_display(body).unwrap().1);
    assert!(!wb.put_display(body).unwrap().1);
    assert_eq!(wb.display().unwrap().unwrap().body["format"], 1);
    http(
        wb.put_display(br#"{"format":2}"#).unwrap_err(),
        422,
        "invalid_payload",
    );
    let hash = wb.put_blob(b"opaque image", "image/png").unwrap();
    assert_eq!(
        wb.get_blob(&hash).unwrap(),
        (b"opaque image".to_vec(), "image/png".into())
    );
    assert!(wb.get_blob("invalid").is_err());
    assert!(wb.verify().unwrap().ok);
    // A distinct workbook's integer cursor must not advance this investigation.
    let (other, v) = d.workbook("other");
    let (other_inv, _) = other
        .create_investigation(json!({"config_version":v}), None)
        .unwrap();
    let remote = wb.remote().unwrap();
    let old = remote.cursor(&inv.id);
    other_inv.append("run", json!({}), None).unwrap();
    assert_eq!(remote.cursor(&inv.id), old);
    let rec = remote
        .stream(&inv.id, Some(0))
        .unwrap()
        .next()
        .unwrap()
        .unwrap();
    assert_eq!(rec.record.investigation, inv.id);
}

#[test]
fn full_synthetic_investigation_over_http() {
    use autophys::{agent::ScriptedPolicy, project::Project, synthetic::thermal_case};
    let d = Daemon::start();
    let (view, evaluator) = thermal_case(0, 1, 0.0, 0.0).unwrap();
    let mut p = Project::new(view.name.clone(), view.simulator);
    p.budgets.max_experiments = 1;
    p.n_starts = 1;
    let wb = d.client().project_with(p).unwrap();
    let mut inv = wb
        .investigate(view.dataset, view.runner, ScriptedPolicy::default())
        .unwrap();
    let outcome = inv.run().unwrap();
    assert_eq!(outcome.status, "validated");
    evaluator.reveal(&inv).unwrap();
    let records = inv.records(None).unwrap();
    for kind in [
        "investigation",
        "measurement",
        "run",
        "step",
        "outcome",
        "reveal",
    ] {
        assert!(records.iter().any(|r| r.kind == kind), "missing {kind}");
    }
    assert!(wb.verify().unwrap().ok);
}

#[test]
fn agent_http_proposal_dashboard_approval_and_resume() {
    use autophys::{
        agent::{ProposalRunner, ScriptedPolicy},
        project::Project,
        synthetic::thermal_case,
    };
    let d = Daemon::start();
    let (mut view, _) = thermal_case(0, 1, 0.0, 0.0).unwrap();
    let mut p = Project::new(view.name.clone(), view.simulator);
    p.budgets.max_experiments = 1;
    p.n_starts = 1;
    let wb = d.client().project_with(p).unwrap();
    assert!(wb.display().unwrap().is_some());
    let mut inv = wb
        .investigate(view.dataset, ProposalRunner, ScriptedPolicy::default())
        .unwrap();
    let out = inv.run().unwrap();
    assert_eq!(out.status, "awaiting_data");
    let pid = out.proposal_id.unwrap();
    inv.record.approve(&pid, "dashboard", None).unwrap();
    assert_eq!(
        inv.wait_for_approval(Duration::from_secs(1))
            .unwrap()
            .status,
        "approved"
    );
    let proposal = inv.record.proposal(&pid).unwrap();
    let obs = view
        .runner
        .run(&json!(proposal.experiment.unwrap()))
        .unwrap();
    inv.attach_data(&pid, obs).unwrap();
    assert_eq!(inv.run().unwrap().status, "validated");
    assert!(wb.verify().unwrap().ok);
}

#[test]
fn competing_remote_attachments_commit_only_one_observation() {
    let d = Daemon::start();
    let (wb, ver) = d.workbook("concurrent-attachment");
    let (inv, _) = wb
        .create_investigation(json!({"config_version":ver}), None)
        .unwrap();
    inv.append(
        "proposal",
        json!({"proposal_id":"p1","event":"proposed","experiment":"e","settings":{}}),
        None,
    )
    .unwrap();
    inv.approve("p1", "test", None).unwrap();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));
    let mut workers = vec![];
    for value in [1, 2] {
        let inv = inv.clone();
        let barrier = barrier.clone();
        workers.push(std::thread::spawn(move || {
            barrier.wait();
            inv.attach_data("p1", json!({"t":[0.0],"y":{"temp":[value]}}))
        }));
    }
    barrier.wait();
    let results: Vec<_> = workers.into_iter().map(|t| t.join().unwrap()).collect();
    assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter(|r| r.as_ref().is_err_and(|e| e.status() == 409))
            .count(),
        1
    );
    assert_eq!(inv.records(Some("measurement")).unwrap().len(), 1);
    assert_eq!(inv.info().unwrap().budget_used, 1);
    assert_eq!(inv.proposal("p1").unwrap().status, "data_attached");
    assert!(wb.verify().unwrap().ok);
}

#[test]
fn limited_page_preserves_undelivered_stream_backlog() {
    let d = Daemon::start();
    let (writer, ver) = d.workbook("paging");
    let (inv, _) = writer
        .create_investigation(json!({"config_version":ver}), None)
        .unwrap();
    for n in 0..3 {
        inv.append("run", json!({"n":n}), None).unwrap();
    }
    // Reads use a fresh transport so its cursor starts before all records.
    let reader = d.client().project_by_id(writer.id()).unwrap();
    let remote = reader.remote().unwrap();
    assert_eq!(remote.cursor(&inv.id), 0);
    let page = reader.records_after(0, 1).unwrap();
    assert_eq!(page.len(), 1);
    assert_eq!(remote.cursor(&inv.id), page[0].gseq);
    let next = remote
        .stream(&inv.id, None)
        .unwrap()
        .next()
        .unwrap()
        .unwrap();
    assert_eq!(next.record.seq, 1);
    assert_eq!(next.gseq, page[0].gseq + 1);
}
