//! `autophys pair | keys | db` against a real database file.

use std::path::Path;
use std::process::ExitCode;

use autophys::admin::run;
use autophys::store::Store;

async fn cli(db: &Path, line: &str) -> (ExitCode, String, String) {
    let mut words = line.split_whitespace().map(str::to_string);
    let command = words.next().unwrap();
    let (mut out, mut err) = (Vec::new(), Vec::new());
    let db = db.to_path_buf();
    let code = run(&command, words, move || Ok(db), &mut out, &mut err).await;
    (
        code,
        String::from_utf8(out).unwrap(),
        String::from_utf8(err).unwrap(),
    )
}

#[actix_web::test]
async fn pair_keys_and_db_commands() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("autophys.db");
    let store = Store::open(&db).unwrap();
    let start = store
        .pair_start("lab-pc", "autophys-python/0.1")
        .await
        .unwrap();

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
    let issued = store.pair_poll(&start.device_code).await.unwrap();
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
        store.authenticate(&issued.api_key).await.unwrap().is_none(),
        "revoked from the CLI"
    );
    assert_eq!(cli(&db, "keys revoke k_missing").await.0, ExitCode::FAILURE);
    assert_eq!(
        cli(&db, "pair approve NOPE-0000").await.0,
        ExitCode::FAILURE
    );

    let (code, out, _) = cli(&db, "db check").await;
    assert_eq!(code, ExitCode::SUCCESS, "{out}");
    assert!(out.contains("projections match the log"));
    let (code, out, _) = cli(&db, "db check --rebuild --json").await;
    assert_eq!(code, ExitCode::SUCCESS);
    assert!(out.contains("\"rebuilt\": true"));

    for bad in ["pair", "keys delete x", "db check --bogus", "pair approve"] {
        assert_eq!(cli(&db, bad).await.0, ExitCode::from(2), "{bad}");
    }
}
