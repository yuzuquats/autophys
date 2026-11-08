//! `autophys pair | keys | db` against a real database file.

use std::path::Path;
use std::process::ExitCode;

use autophys_cli::admin::{Defaults, run};
use autophys_cli::keys::KeyStore;

async fn cli(db: &Path, line: &str) -> (ExitCode, String, String) {
    let mut words = line.split_whitespace().map(str::to_string);
    let command = words.next().unwrap();
    let (mut out, mut err) = (Vec::new(), Vec::new());
    let db = db.to_path_buf();
    let code = run(
        &command,
        words,
        Defaults {
            collection: db.clone(),
            server_db: Some(db.join("server.db")),
            public_url: None,
        },
        &mut out,
        &mut err,
    );
    (
        code,
        String::from_utf8(out).unwrap(),
        String::from_utf8(err).unwrap(),
    )
}

#[actix_web::test]
async fn pair_keys_and_db_commands() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("collection");
    let store = KeyStore::open(db.join("server.db")).unwrap();
    let start = store.pair_start("lab-pc", "autophys-python/0.1").unwrap();

    let (code, out, _) = cli(&db, "pair list").await;
    assert_eq!(code, ExitCode::SUCCESS);
    assert!(out.contains(&start.user_code) && out.contains("lab-pc"));
    assert!(!out.contains(&start.device_code));

    let (code, out, _) = cli(
        &db,
        &format!("pair approve {}", start.user_code.to_lowercase()),
    )
    .await;
    assert_eq!(code, ExitCode::SUCCESS, "{out}");
    let issued = store.pair_poll(&start.device_code).unwrap();
    let (code, out, _) = cli(&db, "keys list").await;
    assert_eq!(code, ExitCode::SUCCESS);
    assert!(
        out.contains(&issued.key_id) && out.contains("never") && !out.contains(&issued.api_key)
    );
    let (_, json, _) = cli(&db, "keys list --json").await;
    assert!(json.contains(&issued.key_id) && !json.contains(&issued.api_key));

    assert_eq!(
        cli(&db, &format!("keys revoke {}", issued.key_id)).await.0,
        ExitCode::SUCCESS
    );
    assert!(
        store.authenticate(&issued.api_key).unwrap().is_none(),
        "revoked from the CLI"
    );
    assert_eq!(cli(&db, "keys revoke k_missing").await.0, ExitCode::FAILURE);
    assert_eq!(
        cli(&db, "pair approve NOPE-0000").await.0,
        ExitCode::FAILURE
    );

    let wb = autophys::connect(Some(db.to_str().unwrap()))
        .unwrap()
        .project("thermal")
        .unwrap();
    let body = b"{}";
    let version = format!("sha256:{}", autophys::sha256_hex([&body[..]]));
    wb.put_config_version(&version, body).unwrap();
    wb.create_investigation(serde_json::json!({"config_version": version}), None)
        .unwrap();
    rusqlite::Connection::open(wb.path())
        .unwrap()
        .execute("UPDATE investigations SET status = 'drift'", [])
        .unwrap();
    assert_eq!(cli(&db, "db verify").await.0, ExitCode::FAILURE);
    assert_eq!(cli(&db, "db verify --rebuild").await.0, ExitCode::SUCCESS);

    let (code, out, _) = cli(&db, "db check").await;
    assert_eq!(code, ExitCode::SUCCESS, "{out}");
    assert!(out.contains("projections match the records"));
    let (code, out, _) = cli(&db, "db check --rebuild --json").await;
    assert_eq!(code, ExitCode::SUCCESS);
    assert!(out.contains("\"rebuilt\": false"));

    for bad in ["pair", "keys delete x", "db check --bogus", "pair approve"] {
        assert_eq!(cli(&db, bad).await.0, ExitCode::from(2), "{bad}");
    }
}
