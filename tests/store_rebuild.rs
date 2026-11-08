//! Projections are a pure function of the log: a rebuild reproduces them
//! exactly, repairs drift, and `db_check` catches a tampered record.

mod common;

use autophys::{Envelope, Kind, Workbook, sha256_hex};
use common::fixture;
use rusqlite::Connection;
use serde_json::{Value, json};

fn envelope(id: &str, kind: Kind, payload: Value) -> Envelope {
    Envelope {
        id: id.into(),
        kind,
        payload,
    }
}

async fn populate(store: &Workbook) -> Vec<String> {
    let body = br#"{"name":"thermal"}"#;
    let version = format!("sha256:{}", sha256_hex([&body[..]]));
    store.put_config_version(&version, body).unwrap();
    let mut invs = Vec::new();
    for n in 0..3 {
        let (investigation, _) = store
            .create_investigation(
                json!({
                    "config_version": version, "overrides": {"free": ["C"]}, "n": n,
                }),
                None,
            )
            .unwrap();
        let inv = investigation.id.clone();
        let id = |s: &str| format!("{inv}-{s}");
        let pid = format!("p{n}");
        let p = |ev: &str, extra: Value| {
            let mut v = json!({"proposal_id": pid, "event": ev});
            v.as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            v
        };
        let steps = [
            envelope(
                &id("m"),
                Kind::Measurement,
                json!({"version": 1, "observation": {"e": "step"}}),
            ),
            envelope(&id("r"), Kind::Run, json!({"loss": 0.5})),
            envelope(
                &id("p"),
                Kind::Proposal,
                p(
                    "proposed",
                    json!({"experiment": "sine", "settings": {"f": 0.4}}),
                ),
            ),
            envelope(
                &id("e"),
                Kind::Proposal,
                p("edited", json!({"settings": {"f": 0.5}})),
            ),
            envelope(
                &id("d"),
                Kind::Proposal,
                p("data_attached", json!({"measurement_version": 2})),
            ),
            envelope(
                &id("m2"),
                Kind::Measurement,
                json!({"version": 2, "observation": {"e": "sine"}}),
            ),
            envelope(
                &id("o"),
                Kind::Outcome,
                json!({"status": if n == 1 { "inconclusive" } else { "validated" }}),
            ),
        ];
        // Leave investigation 2 waiting on a fresh proposal.
        let take = if n == 2 { 3 } else { steps.len() };
        for env in steps.into_iter().take(take) {
            investigation
                .append(env.kind.as_str(), env.payload, Some(&env.id))
                .unwrap();
        }
        invs.push(inv);
    }
    invs
}

async fn snapshot(store: &Workbook) -> (Value, Value) {
    let ws = store.snapshot().unwrap();
    (
        serde_json::to_value(&ws.investigations).unwrap(),
        serde_json::to_value(&ws.proposals).unwrap(),
    )
}

#[actix_web::test]
async fn rebuild_reproduces_the_projections_exactly() {
    let f = fixture();
    let wb = f.api.client.ensure_project("thermal").unwrap().0;
    let invs = populate(&wb).await;
    let before = snapshot(&wb).await;
    let row = |id: &str| {
        before
            .0
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["id"] == id)
            .unwrap()
            .clone()
    };
    assert_eq!(row(&invs[2])["status"], "awaiting_approval");
    assert_eq!(row(&invs[0])["budget_used"], 2);
    assert_eq!(row(&invs[1])["status"], "inconclusive");

    let report = wb.verify().unwrap();
    assert!(report.ok && report.projections_match, "{report:?}");
    assert_eq!((report.investigations, report.records), (3, 2 * 8 + 4));

    let report = wb.rebuild_projections().unwrap();
    assert!(report.ok && report.projections_match);
    assert_eq!(
        snapshot(&wb).await,
        before,
        "rebuilt projections equal the incremental ones"
    );
}

#[actix_web::test]
async fn rebuild_repairs_drifted_projections() {
    let f = fixture();
    let wb = f.api.client.ensure_project("thermal").unwrap().0;
    populate(&wb).await;
    let before = snapshot(&wb).await;
    let raw = Connection::open(wb.path()).unwrap();
    raw.execute_batch(
        "UPDATE investigations SET status = 'bogus', budget_used = 99;
         DELETE FROM proposals WHERE id = 'p1';",
    )
    .unwrap();
    let report = wb.verify().unwrap();
    assert!(!report.projections_match && !report.ok, "drift is reported");
    assert_ne!(snapshot(&wb).await, before, "check alone changes nothing");
    let report = wb.rebuild_projections().unwrap();
    assert!(report.ok);
    assert_eq!(snapshot(&wb).await, before);
}

#[actix_web::test]
async fn the_log_is_append_only_and_tampering_breaks_the_chain() {
    let f = fixture();
    let wb = f.api.client.ensure_project("thermal").unwrap().0;
    let invs = populate(&wb).await;
    let raw = Connection::open(wb.path()).unwrap();
    assert!(
        raw.execute("UPDATE records SET payload = '{}' WHERE gseq = 2", [])
            .is_err()
    );
    assert!(
        raw.execute("DELETE FROM records WHERE gseq = 2", [])
            .is_err()
    );

    // Someone with the file drops the trigger and edits a payload.
    raw.execute_batch(
        "DROP TRIGGER records_no_update;
         UPDATE records SET payload = '{\"loss\":0.25}' WHERE id LIKE '%-r';",
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
    assert!(invs.contains(&report.chain_errors[0].investigation));
    assert!(!report.ok);
}
