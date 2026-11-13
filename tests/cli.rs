//! Exercise the public command tree against real temporary workbooks.
use std::process::{Command, Output};

use serde_json::{Value, json};

fn run(home: &std::path::Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_autophys"))
        .env_clear()
        .env("HOME", home)
        .env("AUTOPHYS_HOME", home)
        .args(args)
        .output()
        .unwrap()
}

fn json_output(home: &std::path::Path, args: &[&str]) -> Value {
    let output = run(home, args);
    assert!(
        output.status.success(),
        "{args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap_or_else(|e| {
        panic!(
            "{args:?}: invalid JSON ({e}): {}",
            String::from_utf8_lossy(&output.stdout)
        )
    })
}

#[test]
fn help_json_needs_no_env_credentials_or_database() {
    let output = Command::new(env!("CARGO_BIN_EXE_autophys"))
        .env_clear()
        .args(["--help", "--json"])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let tree: Value = serde_json::from_slice(&output.stdout).unwrap();
    let text = tree.to_string();
    for command in [
        "serve",
        "build-web",
        "pack",
        "pair",
        "keys",
        "db",
        "projects",
        "investigations",
        "records",
        "approve",
        "reject",
        "verify",
        "overview",
    ] {
        assert!(
            text.contains(&format!("\"{command}\"")),
            "missing {command}: {tree}"
        );
    }
}

#[test]
fn sdk_verbs_read_and_decide_in_a_temp_collection() {
    let home = tempfile::tempdir().unwrap();
    let client = autophys::connect(Some(home.path().to_str().unwrap())).unwrap();
    let wb = client.ensure_project("thermal").unwrap().0;
    let body: &[u8] = br#"{"model":"thermal"}"#;
    let version = format!("sha256:{}", autophys::sha256_hex([body]));
    wb.put_config_version(&version, body).unwrap();
    let (inv, _) = wb
        .create_investigation(json!({"config_version": version}), None)
        .unwrap();
    let id = inv.info().unwrap().id;
    for pid in ["proposal-a", "proposal-b"] {
        inv.append("proposal", json!({"proposal_id":pid, "event":"proposed", "experiment":"step", "settings":{"power":1}}), None).unwrap();
    }
    let projects = json_output(home.path(), &["projects", "--json"]);
    assert_eq!(projects[0]["name"], "thermal");
    let investigations = json_output(
        home.path(),
        &["investigations", "--project", "thermal", "--json"],
    );
    assert_eq!(investigations[0]["id"], id);
    let records = json_output(
        home.path(),
        &["records", &id, "--kind", "proposal", "--json"],
    );
    assert_eq!(records.as_array().unwrap().len(), 2);
    let approved = json_output(
        home.path(),
        &[
            "approve",
            &id,
            "proposal-a",
            "--by",
            "james",
            "--settings",
            "{\"power\":2}",
            "--json",
        ],
    );
    assert_eq!(approved["record"]["payload"]["event"], "edited");
    let rejected = json_output(
        home.path(),
        &[
            "reject",
            &id,
            "proposal-b",
            "--by",
            "james",
            "--reason",
            "help",
            "--json",
        ],
    );
    assert_eq!(rejected["record"]["payload"]["event"], "rejected");
    assert_eq!(rejected["record"]["payload"]["reason"], "help");
    let verified = json_output(home.path(), &["verify", "--json"]);
    assert_eq!(verified[0]["report"]["ok"], true);
    // Explicit file targets win over AUTOPHYS_HOME; no other collection opens.
    let target = wb.path().to_str().unwrap();
    let projects = json_output(home.path(), &["projects", "--target", target, "--json"]);
    assert_eq!(projects.as_array().unwrap().len(), 1);
    let elsewhere = tempfile::tempdir().unwrap();
    assert!(
        json_output(
            home.path(),
            &[
                "projects",
                "--target",
                elsewhere.path().to_str().unwrap(),
                "--json"
            ]
        )
        .as_array()
        .unwrap()
        .is_empty()
    );
    assert!(wb.verify().unwrap().ok);
}

#[test]
fn usage_errors_exit_two_and_runtime_errors_exit_one() {
    let home = tempfile::tempdir().unwrap();
    for args in [
        vec!["nonsense"],
        vec!["serve", "--bogus"],
        vec!["serve", "--addr", "0.0.0.0:4794"],
        vec!["pack", "--out", "x"],
        vec!["build-web", "--bundle"],
        vec!["records"],
        vec!["approve"],
        vec!["reject"],
        vec!["projects", "--bogus"],
        vec!["pair"],
        vec!["keys"],
        vec!["db"],
        vec!["db", "nonsense"],
    ] {
        let output = run(home.path(), &args);
        assert_eq!(
            output.status.code(),
            Some(2),
            "{args:?}: stdout={} stderr={}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
    let output = run(home.path(), &["records", "missing-investigation", "--json"]);
    assert_eq!(output.status.code(), Some(1));
}

#[test]
fn admin_flags_and_json_still_work() {
    let home = tempfile::tempdir().unwrap();
    let db = home.path().join("server.db");
    let db = db.to_str().unwrap();
    let keys = json_output(home.path(), &["keys", "list", "--server-db", db, "--json"]);
    assert_eq!(keys, json!([]));
    let verify = json_output(
        home.path(),
        &[
            "db",
            "check",
            "--db",
            home.path().to_str().unwrap(),
            "--json",
        ],
    );
    assert_eq!(verify, json!([]));
}

#[test]
fn failed_verification_keeps_json_output_and_exits_one() {
    let home = tempfile::tempdir().unwrap();
    let client = autophys::connect(Some(home.path().to_str().unwrap())).unwrap();
    let wb = client.ensure_project("drifted").unwrap().0;
    let body: &[u8] = br#"{"model":"thermal"}"#;
    let version = format!("sha256:{}", autophys::sha256_hex([body]));
    wb.put_config_version(&version, body).unwrap();
    wb.create_investigation(json!({"config_version":version}), None)
        .unwrap();
    rusqlite::Connection::open(wb.path())
        .unwrap()
        .execute("UPDATE investigations SET status = 'completed'", [])
        .unwrap();
    for args in [vec!["verify", "--json"], vec!["db", "verify", "--json"]] {
        let output = run(home.path(), &args);
        assert_eq!(
            output.status.code(),
            Some(1),
            "{args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let reports: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(reports[0]["report"]["ok"], false);
        assert_eq!(reports[0]["report"]["projections_match"], false);
    }
}

/// G4 (operator decision 2026-11-08): a failure writes nothing to stdout and
/// one `autophys: REASON` line to stderr, plus a `--help` pointer when the
/// arguments were wrong. `--json | jq` never sees usage text.
#[test]
fn failures_are_one_stderr_line_with_a_help_hint_and_no_stdout() {
    let home = tempfile::tempdir().unwrap();
    let hint = |command: &str| format!("Try `autophys {command} --help` for the options.\n");
    let cases: Vec<(Vec<&str>, i32, String)> = vec![
        (
            vec!["records", "--json"],
            2,
            format!("autophys: missing required option --investigation\n{}", hint("records")),
        ),
        (
            vec!["records", "--investigation", "x", "--jsn"],
            2,
            format!("autophys: unknown option \"--jsn\"\n{}", hint("records")),
        ),
        (
            vec!["approve"],
            2,
            format!("autophys: missing required option --investigation\n{}", hint("approve")),
        ),
        (
            vec!["verify", "nope.ap-workbook"],
            2,
            format!("autophys: unexpected argument \"nope.ap-workbook\"\n{}", hint("verify")),
        ),
        (
            vec!["train", "--bogus"],
            2,
            format!(
                "autophys: unknown option \"--bogus\"; train needs a subcommand\n{}",
                hint("train")
            ),
        ),
        (
            vec!["train", "dataset", "--bogus"],
            2,
            format!("autophys: unknown option \"--bogus\"\n{}", hint("train dataset")),
        ),
        (
            vec!["new", "--bogus"],
            2,
            format!("autophys: unknown option \"--bogus\"\n{}", hint("new")),
        ),
        (
            vec!["--json", "records", "--bogus"],
            2,
            format!("autophys: unknown option \"--bogus\"\n{}", hint("records")),
        ),
        (
            vec!["fit"],
            2,
            "autophys: unknown command \"fit\"\nTry `autophys --help` for the commands.\n".into(),
        ),
        (
            vec!["records", "--investigation", "inv_nope", "--json"],
            1,
            "autophys: unknown investigation\n".into(),
        ),
    ];
    for (args, code, expected) in cases {
        let output = run(home.path(), &args);
        assert_eq!(output.status.code(), Some(code), "{args:?}");
        assert!(
            output.stdout.is_empty(),
            "{args:?}: stdout={}",
            String::from_utf8_lossy(&output.stdout)
        );
        assert_eq!(String::from_utf8_lossy(&output.stderr), expected, "{args:?}");
    }
}

#[test]
fn overview_set_and_show_write_and_read_the_latest_version() {
    let home = tempfile::tempdir().unwrap();
    let client = autophys::connect(Some(home.path().to_str().unwrap())).unwrap();
    let wb = client.ensure_project("thermal").unwrap().0;
    let file = home.path().join("overview.md");
    let md = "# Thermal \u{e9}\n\n<ap-investigation investigation=\"inv_gone\"></ap-investigation>\n";
    std::fs::write(&file, md).unwrap();
    let path = file.to_str().unwrap();
    // Before the first write: nothing printed, null as JSON, format 1 kept.
    let shown = run(home.path(), &["overview", "show", "thermal"]);
    assert!(shown.status.success() && shown.stdout.is_empty());
    assert_eq!(json_output(home.path(), &["overview", "show", "thermal", "--json"]), json!({"project_id": wb.id(), "overview": null}));
    let set = json_output(home.path(), &["overview", "set", "thermal", path, "--author", "ada", "--json"]);
    assert_eq!((&set["changed"], &set["overview"]["seq"], &set["overview"]["author"]), (&json!(true), &json!(1), &json!("ada")));
    assert_eq!(set["warnings"][0]["investigation"], "inv_gone");
    let again = json_output(home.path(), &["overview", "set", wb.id(), path, "--json"]);
    assert_eq!(again["changed"], false);
    let plain = run(home.path(), &["overview", "set", "thermal", path]);
    assert!(plain.status.success());
    assert!(String::from_utf8_lossy(&plain.stderr).contains("warning: <ap-investigation> names \"inv_gone\""));
    let shown = run(home.path(), &["overview", "show", "thermal"]);
    assert_eq!(String::from_utf8(shown.stdout).unwrap(), md, "exactly the stored Markdown");
    let latest = json_output(home.path(), &["overview", "show", "thermal", "--json"])["overview"].take();
    assert_eq!((&latest["markdown"], &latest["author"]), (&json!(md), &json!("ada")));
    assert_eq!(wb.overview_versions().unwrap().len(), 1);
    // The default author, and the refusals and lookups that fail.
    std::fs::write(&file, "# Two\n").unwrap();
    assert_eq!(json_output(home.path(), &["overview", "set", "thermal", path, "--json"])["overview"]["author"], "operator");
    std::fs::write(&file, " \n").unwrap();
    assert_eq!(run(home.path(), &["overview", "set", "thermal", path]).status.code(), Some(1));
    std::fs::write(&file, b"\xff").unwrap();
    assert_eq!(run(home.path(), &["overview", "set", "thermal", path]).status.code(), Some(1));
    assert_eq!(run(home.path(), &["overview", "show", "nope"]).status.code(), Some(1));
    assert_eq!(run(home.path(), &["overview"]).status.code(), Some(2));
    assert_eq!(wb.overview_versions().unwrap().len(), 2);
}
