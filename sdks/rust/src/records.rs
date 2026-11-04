//! The record log: the row type and the queries the store needs.

use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::Serialize;
use serde_json::Value;

use crate::error::{Error, Result};

/// A record exactly as the SDK's `Record` dataclass has it. The global cursor
/// `gseq` travels beside it ([`Logged`]), never inside, because the SDK
/// builds `Record(**json)` and would reject an extra field.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Record {
    pub id: String,
    pub investigation: String,
    pub seq: i64,
    pub kind: String,
    pub ts: f64,
    pub payload: Value,
    pub prev_hash: String,
    pub hash: String,
}

/// A record with its global position in the log.
#[derive(Clone, Debug, PartialEq)]
pub struct Logged {
    pub gseq: i64,
    pub record: Record,
}

pub(crate) const COLUMNS: &str = "gseq, id, investigation, seq, kind, ts, payload, prev_hash, hash";

pub(crate) fn from_row(row: &Row<'_>) -> rusqlite::Result<(Logged, String)> {
    let payload_text: String = row.get(6)?;
    let payload = serde_json::from_str(&payload_text).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(6, rusqlite::types::Type::Text, Box::new(e))
    })?;
    Ok((
        Logged {
            gseq: row.get(0)?,
            record: Record {
                id: row.get(1)?,
                investigation: row.get(2)?,
                seq: row.get(3)?,
                kind: row.get(4)?,
                ts: row.get(5)?,
                payload,
                prev_hash: row.get(7)?,
                hash: row.get(8)?,
            },
        },
        payload_text,
    ))
}

/// The record with client id `id`, and its stored canonical payload text.
pub(crate) fn by_id(conn: &Connection, id: &str) -> Result<Option<(Logged, String)>> {
    Ok(conn
        .query_row(
            &format!("SELECT {COLUMNS} FROM records WHERE id = ?1"),
            [id],
            from_row,
        )
        .optional()?)
}

/// `(seq, hash)` of an investigation's last record, if it has one.
pub(crate) fn head(conn: &Connection, inv: &str) -> Result<Option<(i64, String)>> {
    Ok(conn
        .query_row(
            "SELECT seq, hash FROM records WHERE investigation = ?1 ORDER BY seq DESC LIMIT 1",
            [inv],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?)
}

pub(crate) fn insert(conn: &Connection, rec: &Record, payload_text: &str) -> Result<i64> {
    conn.execute(
        "INSERT INTO records (id, investigation, seq, kind, ts, payload, prev_hash, hash)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            rec.id,
            rec.investigation,
            rec.seq,
            rec.kind,
            rec.ts,
            payload_text,
            rec.prev_hash,
            rec.hash
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

/// An investigation's records in `seq` order, optionally one kind only.
pub(crate) fn of_investigation(
    conn: &Connection,
    inv: &str,
    kind: Option<&str>,
) -> Result<Vec<Record>> {
    let mut stmt = conn.prepare_cached(&format!(
        "SELECT {COLUMNS} FROM records WHERE investigation = ?1 AND (?2 IS NULL OR kind = ?2) ORDER BY seq"
    ))?;
    let rows = stmt.query_map(params![inv, kind], from_row)?;
    rows.map(|r| r.map(|(l, _)| l.record).map_err(Error::from))
        .collect()
}

/// Up to `limit` records after global cursor `after`, in `gseq` order,
/// optionally of one investigation only.
pub(crate) fn after(
    conn: &Connection,
    after: i64,
    limit: i64,
    inv: Option<&str>,
) -> Result<Vec<Logged>> {
    let mut stmt = conn.prepare_cached(&format!(
        "SELECT {COLUMNS} FROM records WHERE gseq > ?1 AND (?3 IS NULL OR investigation = ?3)
          ORDER BY gseq LIMIT ?2"
    ))?;
    let rows = stmt.query_map(params![after, limit, inv], from_row)?;
    rows.map(|r| r.map(|(l, _)| l).map_err(Error::from))
        .collect()
}

/// The highest `gseq` written so far (0 for an empty log).
pub(crate) fn cursor(conn: &Connection) -> Result<i64> {
    Ok(
        conn.query_row("SELECT COALESCE(MAX(gseq), 0) FROM records", [], |r| {
            r.get(0)
        })?,
    )
}

/// Record-derived inference context. These fields are not projection columns.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct ReasonMetadata {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub playbook: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub price: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage_total: Option<Value>,
    /// Step payloads in record order; raw historical usage is preserved.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub steps: Vec<Value>,
}
impl ReasonMetadata {
    pub(crate) fn read(conn: &Connection, investigation: &str) -> Result<Self> {
        let mut out = Self::default();
        for record in of_investigation(conn, investigation, None)? {
            match record.kind.as_str() {
                "investigation" => {
                    out.playbook = record.payload.get("playbook").cloned();
                    out.model = record.payload.get("model").cloned();
                    out.price = record.payload.get("price").cloned();
                }
                "step" => out.steps.push(record.payload),
                "outcome" => out.usage_total = record.payload.get("usage_total").cloned(),
                _ => {}
            }
        }
        Ok(out.with_live_total())
    }

    /// Until the outcome records `usage_total`, derive it from the steps with
    /// the same rule, so a running investigation can show cost and tokens.
    fn with_live_total(mut self) -> Self {
        if self.usage_total.is_none() && self.steps.iter().any(|s| s.get("usage").is_some()) {
            self.usage_total = Some(crate::usage::usage_total(&self.steps));
        }
        self
    }
}

#[cfg(test)]
mod live_total_tests {
    use super::ReasonMetadata;
    use serde_json::json;

    #[test]
    fn a_running_investigation_totals_its_steps_and_an_outcome_wins() {
        let step =
            |i, o, c| json!({"usage": {"input_tokens": i, "output_tokens": o, "cost_usd": c}});
        let running = ReasonMetadata {
            steps: vec![
                step(100, 10, 0.5),
                json!({"usage": {"prompt_tokens": 7}}),
                step(50, 5, 0.25),
            ],
            ..Default::default()
        }
        .with_live_total();
        assert_eq!(
            running.usage_total,
            Some(json!({"calls": 2, "input_tokens": 150, "output_tokens": 15, "cost_usd": 0.75}))
        );
        let recorded = json!({"calls": 9, "input_tokens": 1, "output_tokens": 1, "cost_usd": null});
        let done = ReasonMetadata {
            usage_total: Some(recorded.clone()),
            steps: vec![step(100, 10, 0.5)],
            ..Default::default()
        }
        .with_live_total();
        assert_eq!(done.usage_total, Some(recorded));
        let unpriced = ReasonMetadata {
            steps: vec![json!({"observation": 1})],
            ..Default::default()
        }
        .with_live_total();
        assert_eq!(unpriced.usage_total, None, "no usage, no total");
    }
}
