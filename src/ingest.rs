//! The one event path: every write, SDK or browser, is a record appended
//! here. Order inside one transaction: idempotent replay by client id, then
//! payload validation (422 with a field path), then `projections::check` (409
//! on an illegal proposal transition), then seq and hash chain, insert,
//! projections; after the commit the writer thread broadcasts the record.

use std::sync::Arc;

use rusqlite::{Connection, OptionalExtension};
use serde_json::{Map, Value};

use crate::store::validate::Envelope;
use crate::store::{
    Appended, GENESIS, Kind, Logged, NewInvestigation, Record, Result, Store, StoreError,
    canonical, chain_hash, keys, now, projections, records, ts_of, validate,
};

impl Store {
    /// Append a client envelope to investigation `inv`:
    /// idempotent replay by `env.id` → payload validation (422) →
    /// [`projections::check`] (409) → seq and hash chain → insert →
    /// [`projections::apply`], all in one transaction, then broadcast.
    pub async fn append(&self, inv: &str, env: Envelope) -> Result<Appended> {
        if env.kind == Kind::Investigation {
            return Err(StoreError::BadRequest(
                "investigation records are created by POST /investigations".into(),
            ));
        }
        validate::check_id("id", &env.id)?;
        validate::payload_shape(env.kind, &env.payload)?;
        let text = canonical(&env.payload);
        if text.len() > validate::MAX_PAYLOAD_BYTES {
            return Err(StoreError::TooLarge(validate::MAX_PAYLOAD_BYTES));
        }
        let inv = inv.to_string();
        let bus = self.inner.bus.clone();
        self.write(move |conn| {
            let tx = conn.transaction()?;
            if let Some(replay) = replay(&tx, &env.id, &inv, env.kind, &text)? {
                return Ok(replay);
            }
            if !projections::investigation_exists(&tx, &inv)? {
                return Err(StoreError::NotFound("investigation"));
            }
            projections::check(&tx, &inv, &env)?;
            let logged = insert_record(&tx, &inv, &env.id, env.kind, &text)?;
            tx.commit()?;
            let _ = bus.send(Arc::new(logged.clone()));
            Ok(Appended {
                gseq: logged.gseq,
                record: logged.record,
                created: true,
            })
        })
        .await
    }

    /// `POST /investigations`: check the pinned config version (409
    /// `unknown_config_version`), mint an id, and append the investigation's
    /// first record (seq 0). `record_id` is the client's Idempotency-Key;
    /// replaying it returns the same investigation with `created = false`.
    pub async fn create_investigation(
        &self,
        req: NewInvestigation,
        record_id: Option<String>,
    ) -> Result<(String, bool)> {
        let record_id = match record_id {
            Some(id) => {
                validate::check_id("Idempotency-Key", &id)?;
                id
            }
            None => keys::random_hex(16)?,
        };
        let overrides = match req.overrides {
            Value::Null => Value::Object(Map::new()),
            v @ Value::Object(_) => v,
            _ => return Err(StoreError::invalid("overrides", "must be an object")),
        };
        let mut payload = match req.meta {
            Value::Null => Map::new(),
            Value::Object(m) => m,
            _ => return Err(StoreError::invalid("meta", "must be an object")),
        };
        // The pin travels in the record, so the projection rebuilds from the log.
        payload.insert("project_id".into(), Value::String(req.project_id.clone()));
        payload.insert(
            "config_version".into(),
            Value::String(req.config_version.clone()),
        );
        payload.insert("overrides".into(), overrides);
        let payload = Value::Object(payload);
        validate::payload_shape(Kind::Investigation, &payload).map_err(|_| {
            StoreError::invalid(
                "project_id",
                "project_id and config_version are required strings",
            )
        })?;
        let text = canonical(&payload);
        if text.len() > validate::MAX_PAYLOAD_BYTES {
            return Err(StoreError::TooLarge(validate::MAX_PAYLOAD_BYTES));
        }
        let bus = self.inner.bus.clone();
        self.write(move |conn| {
            let tx = conn.transaction()?;
            if let Some((existing, stored)) = records::by_id(&tx, &record_id)? {
                if existing.record.kind == Kind::Investigation.as_str() && stored == text {
                    return Ok((existing.record.investigation, false));
                }
                return Err(idempotency_conflict(&record_id));
            }
            let pinned: bool = tx
                .query_row(
                    "SELECT 1 FROM config_versions WHERE project = ?1 AND version = ?2",
                    [&req.project_id, &req.config_version],
                    |_| Ok(()),
                )
                .optional()?
                .is_some();
            if !pinned {
                return Err(StoreError::conflict(
                    "unknown_config_version",
                    "PUT the config version first",
                ));
            }
            let inv = format!("inv_{}", keys::random_hex(8)?);
            let logged = insert_record(&tx, &inv, &record_id, Kind::Investigation, &text)?;
            tx.commit()?;
            let _ = bus.send(Arc::new(logged));
            Ok((inv, true))
        })
        .await
    }
}

fn idempotency_conflict(id: &str) -> StoreError {
    StoreError::conflict(
        "idempotency_conflict",
        format!("record id {id} was already used for a different record"),
    )
}

/// If `id` exists: the stored record when it is the same record (replay),
/// else a 409. `None` when the id is new.
fn replay(
    conn: &Connection,
    id: &str,
    inv: &str,
    kind: Kind,
    text: &str,
) -> Result<Option<Appended>> {
    let Some((existing, stored)) = records::by_id(conn, id)? else {
        return Ok(None);
    };
    let r = &existing.record;
    if r.investigation == inv && r.kind == kind.as_str() && stored == text {
        return Ok(Some(Appended {
            gseq: existing.gseq,
            record: existing.record,
            created: false,
        }));
    }
    Err(idempotency_conflict(id))
}

/// Chain, insert and project one record inside the caller's transaction.
fn insert_record(conn: &Connection, inv: &str, id: &str, kind: Kind, text: &str) -> Result<Logged> {
    let (seq, prev) = match records::head(conn, inv)? {
        Some((seq, hash)) => (seq + 1, hash),
        None => (0, GENESIS.to_string()),
    };
    let payload: Value = serde_json::from_str(text)
        .map_err(|e| StoreError::Internal(format!("canonical payload reparse: {e}")))?;
    let hash = chain_hash(&prev, id, kind.as_str(), &payload);
    let record = Record {
        id: id.to_string(),
        investigation: inv.to_string(),
        seq,
        kind: kind.as_str().to_string(),
        ts: ts_of(now()),
        payload,
        prev_hash: prev,
        hash,
    };
    let gseq = records::insert(conn, &record, text)?;
    projections::apply(conn, &record)?;
    Ok(Logged { gseq, record })
}
