//! Projections: `investigations` and `proposals`, derived only from records.
//!
//! [`check`] runs before an append and refuses illegal proposal transitions
//! (409); [`apply`] runs in the same transaction after the insert. Because
//! `apply` reads nothing but the record and the projection rows, replaying
//! the log in `gseq` order rebuilds both tables exactly ([`rebuild`]).

use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use serde_json::Value;

use crate::store::canonical::canonical;
use crate::store::error::{Result, StoreError};
use crate::store::records::{self, Record};
use crate::store::validate::{Envelope, Event, Kind};

/// An investigation row (`GET /investigations`, `/workspace`).
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Investigation {
    pub id: String,
    pub project_id: String,
    pub config_version: String,
    pub overrides: Value,
    /// `open`, `awaiting_approval`, `awaiting_data`, or the last outcome's status.
    pub status: String,
    /// Measurements recorded so far.
    pub budget_used: i64,
    pub created: f64,
    pub updated: f64,
}

/// A proposal's folded state (`GET …/proposals/{pid}`, `/workspace`).
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Proposal {
    pub investigation: String,
    pub proposal_id: String,
    /// proposed | approved | edited | rejected | withdrawn | data_attached
    pub status: String,
    pub experiment: Option<String>,
    pub settings: Option<Value>,
    pub updated: f64,
}

pub(crate) fn investigation_exists(conn: &Connection, inv: &str) -> Result<bool> {
    Ok(conn
        .query_row("SELECT 1 FROM investigations WHERE id = ?1", [inv], |_| {
            Ok(())
        })
        .optional()?
        .is_some())
}

pub(crate) fn proposal_state(conn: &Connection, inv: &str, pid: &str) -> Result<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT state FROM proposals WHERE investigation = ?1 AND id = ?2",
            [inv, pid],
            |r| r.get(0),
        )
        .optional()?)
}

/// Refuse an append the proposal state machine does not allow:
/// `proposed → approved | edited | rejected | withdrawn`,
/// `approved | edited → data_attached`.
pub fn check(conn: &Connection, inv: &str, env: &Envelope) -> Result<()> {
    let Some((pid, ev)) = env.proposal() else {
        return Ok(());
    };
    let state = proposal_state(conn, inv, pid)?;
    match (ev, state.as_deref()) {
        (Event::Proposed, None) => Ok(()),
        (Event::Proposed, Some(s)) => Err(StoreError::conflict(
            "proposal_exists",
            format!("proposal {pid} already exists and is {s}"),
        )),
        (_, None) => Err(StoreError::NotFound("proposal")),
        (Event::Edited, Some("proposed")) => check_edit(conn, inv, pid, env),
        (Event::Approved | Event::Rejected | Event::Withdrawn, Some("proposed")) => Ok(()),
        (Event::DataAttached, Some("approved" | "edited")) => Ok(()),
        (ev, Some(s)) => Err(StoreError::conflict(
            "conflict",
            format!("proposal is {s}; {} is not allowed", ev.as_str()),
        )),
    }
}

/// An `edited` decision may only move settings the proposal's outlook
/// covers, and only within each axis's range (inclusive). Settings that are
/// not outlook axes must keep their proposed values. A proposal without an
/// outlook is not checked: the store cannot know what is editable.
fn check_edit(conn: &Connection, inv: &str, pid: &str, env: &Envelope) -> Result<()> {
    let proposed: Option<String> = conn
        .query_row(
            "SELECT payload FROM records
              WHERE investigation = ?1 AND kind = 'proposal'
                AND json_extract(payload, '$.proposal_id') = ?2
                AND json_extract(payload, '$.event') = 'proposed'",
            [inv, pid],
            |r| r.get(0),
        )
        .optional()?;
    let proposed: Value = match proposed {
        Some(text) => serde_json::from_str(&text)
            .map_err(|e| StoreError::Internal(format!("stored proposal: {e}")))?,
        None => return Ok(()),
    };
    let Some(axes) = proposed.pointer("/outlook/axes").and_then(Value::as_array) else {
        return Ok(());
    };
    let ranges: Vec<(&str, f64, f64)> = axes
        .iter()
        .filter_map(|a| {
            let name = a.get("name")?.as_str()?;
            let values: Vec<f64> = a
                .get("values")?
                .as_array()?
                .iter()
                .filter_map(Value::as_f64)
                .collect();
            let lo = values.iter().copied().fold(f64::INFINITY, f64::min);
            let hi = values.iter().copied().fold(f64::NEG_INFINITY, f64::max);
            Some((name, lo, hi))
        })
        .collect();
    let before = proposed.get("settings").and_then(Value::as_object);
    let Some(after) = env.payload.get("settings").and_then(Value::as_object) else {
        return Ok(()); // validate.rs already requires the object
    };
    for (key, value) in after {
        let at = format!("payload.settings.{key}");
        match ranges.iter().find(|(name, _, _)| name == key) {
            Some(&(_, lo, hi)) => {
                let slack = 1e-9 * lo.abs().max(hi.abs()).max(1.0);
                match value.as_f64() {
                    Some(x) if x >= lo - slack && x <= hi + slack => {}
                    Some(x) => {
                        return Err(StoreError::invalid(
                            at,
                            format!("{x} is outside the outlook axis [{lo}, {hi}]"),
                        ));
                    }
                    None => {
                        return Err(StoreError::invalid(
                            at,
                            "must be a number (it is an outlook axis)",
                        ));
                    }
                }
            }
            None => {
                let unchanged = before
                    .and_then(|b| b.get(key))
                    .is_some_and(|old| canonical(old) == canonical(value));
                if !unchanged {
                    return Err(StoreError::invalid(
                        at,
                        "is not an outlook axis, so it cannot be edited",
                    ));
                }
            }
        }
    }
    Ok(())
}

/// Fold one record into the projections. Reads only `rec` and existing rows.
pub fn apply(conn: &Connection, rec: &Record) -> Result<()> {
    let p = &rec.payload;
    let text = |k: &str| p.get(k).and_then(Value::as_str).map(str::to_owned);
    match Kind::parse(&rec.kind) {
        Some(Kind::Investigation) => {
            let overrides = p
                .get("overrides")
                .cloned()
                .unwrap_or_else(|| Value::Object(Default::default()));
            conn.execute(
                "INSERT INTO investigations
                   (id, project, config_version, overrides, status, budget_used, created, updated)
                 VALUES (?1, ?2, ?3, ?4, 'open', 0, ?5, ?5)",
                params![
                    rec.investigation,
                    text("project_id").unwrap_or_default(),
                    text("config_version").unwrap_or_default(),
                    canonical(&overrides),
                    rec.ts
                ],
            )?;
            return Ok(());
        }
        Some(Kind::Measurement) => {
            conn.execute(
                "UPDATE investigations SET budget_used = budget_used + 1 WHERE id = ?1",
                [&rec.investigation],
            )?;
        }
        Some(Kind::Outcome) => {
            if let Some(status) = text("status") {
                set_status(conn, &rec.investigation, &status)?;
            }
        }
        Some(Kind::Proposal) => apply_proposal(conn, rec)?,
        Some(Kind::Run | Kind::Step) | None => {}
    }
    conn.execute(
        "UPDATE investigations SET updated = ?2 WHERE id = ?1",
        params![rec.investigation, rec.ts],
    )?;
    Ok(())
}

fn apply_proposal(conn: &Connection, rec: &Record) -> Result<()> {
    let p = &rec.payload;
    let (Some(pid), Some(ev)) = (
        p.get("proposal_id").and_then(Value::as_str),
        p.get("event")
            .and_then(Value::as_str)
            .and_then(Event::parse),
    ) else {
        return Ok(());
    };
    let inv = &rec.investigation;
    let settings = p.get("settings").filter(|v| !v.is_null()).map(canonical);
    if ev == Event::Proposed {
        conn.execute(
            "INSERT INTO proposals (investigation, id, state, experiment, settings, updated)
             VALUES (?1, ?2, 'proposed', ?3, ?4, ?5)",
            params![
                inv,
                pid,
                p.get("experiment").and_then(Value::as_str),
                settings,
                rec.ts
            ],
        )?;
    } else {
        conn.execute(
            "UPDATE proposals SET state = ?3, updated = ?4 WHERE investigation = ?1 AND id = ?2",
            params![inv, pid, ev.as_str(), rec.ts],
        )?;
        if ev == Event::Edited {
            conn.execute(
                "UPDATE proposals SET settings = ?3 WHERE investigation = ?1 AND id = ?2",
                params![inv, pid, settings],
            )?;
        }
    }
    let status = match ev {
        Event::Proposed => "awaiting_approval",
        Event::Approved | Event::Edited => "awaiting_data",
        Event::Rejected | Event::Withdrawn | Event::DataAttached => "open",
    };
    set_status(conn, inv, status)
}

fn set_status(conn: &Connection, inv: &str, status: &str) -> Result<()> {
    conn.execute(
        "UPDATE investigations SET status = ?2 WHERE id = ?1",
        [inv, status],
    )?;
    Ok(())
}

/// Empty both projection tables and replay every record in `gseq` order.
pub fn rebuild(conn: &Connection) -> Result<()> {
    conn.execute_batch("DELETE FROM proposals; DELETE FROM investigations;")?;
    let mut cursor = 0;
    loop {
        let page = records::after(conn, cursor, 1000, None)?;
        let Some(last) = page.last() else { break };
        cursor = last.gseq;
        for l in &page {
            apply(conn, &l.record)?;
        }
    }
    Ok(())
}

/// Every projection row as text, in key order: what rebuild equality compares.
pub fn dump(conn: &Connection) -> Result<Vec<String>> {
    let mut out = Vec::new();
    for sql in [
        "SELECT 'i', id, project, config_version, overrides, status, budget_used, created, updated
           FROM investigations ORDER BY id",
        "SELECT 'p', investigation, id, state, experiment, settings, updated
           FROM proposals ORDER BY investigation, id",
    ] {
        let mut stmt = conn.prepare(sql)?;
        let n = stmt.column_count();
        let mut rows = stmt.query([])?;
        while let Some(row) = rows.next()? {
            let mut cells = Vec::with_capacity(n);
            for i in 0..n {
                let v: rusqlite::types::Value = row.get(i)?;
                cells.push(format!("{v:?}"));
            }
            out.push(cells.join("\u{1f}"));
        }
    }
    Ok(out)
}

pub(crate) fn investigations(conn: &Connection) -> Result<Vec<Investigation>> {
    let mut stmt = conn.prepare_cached(
        "SELECT id, project, config_version, overrides, status, budget_used, created, updated
           FROM investigations ORDER BY created, id",
    )?;
    let rows = stmt.query_map([], |r| {
        let overrides: String = r.get(3)?;
        Ok(Investigation {
            id: r.get(0)?,
            project_id: r.get(1)?,
            config_version: r.get(2)?,
            overrides: serde_json::from_str(&overrides).unwrap_or(Value::Null),
            status: r.get(4)?,
            budget_used: r.get(5)?,
            created: r.get(6)?,
            updated: r.get(7)?,
        })
    })?;
    rows.map(|r| r.map_err(StoreError::from)).collect()
}

pub(crate) fn proposals(conn: &Connection, only: Option<(&str, &str)>) -> Result<Vec<Proposal>> {
    let (inv, pid) = only.unzip();
    let mut stmt = conn.prepare_cached(
        "SELECT investigation, id, state, experiment, settings, updated FROM proposals
          WHERE (?1 IS NULL OR investigation = ?1) AND (?2 IS NULL OR id = ?2)
          ORDER BY investigation, updated, id",
    )?;
    let rows = stmt.query_map(params![inv, pid], |r| {
        let settings: Option<String> = r.get(4)?;
        Ok(Proposal {
            investigation: r.get(0)?,
            proposal_id: r.get(1)?,
            status: r.get(2)?,
            experiment: r.get(3)?,
            settings: settings.and_then(|s| serde_json::from_str(&s).ok()),
            updated: r.get(5)?,
        })
    })?;
    rows.map(|r| r.map_err(StoreError::from)).collect()
}
