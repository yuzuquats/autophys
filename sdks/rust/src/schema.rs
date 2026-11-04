//! The `.ap-workbook` schema (workbook-format.md, version 1) and its
//! migrations, keyed by `PRAGMA user_version`. Append a step; never edit one
//! that has shipped.

use rusqlite::{Connection, TransactionBehavior};

use crate::error::{Error, Result};

/// `PRAGMA application_id` of a workbook: ASCII `APWB`.
pub const APPLICATION_ID: i64 = 0x4150_5742;

const MIGRATIONS: &[&str] = &[
    // 1: the log, its projections, the project, config versions and blobs.
    r#"
    CREATE TABLE records (
      gseq          INTEGER PRIMARY KEY,      -- order within this workbook
      id            TEXT NOT NULL UNIQUE,     -- client-chosen record id
      investigation TEXT NOT NULL,
      seq           INTEGER NOT NULL,         -- per-investigation order, from 0
      kind          TEXT NOT NULL,
      ts            REAL NOT NULL,            -- unix seconds, microsecond precision
      payload       TEXT NOT NULL,            -- canonical JSON
      prev_hash     TEXT NOT NULL,
      hash          TEXT NOT NULL,
      UNIQUE (investigation, seq)
    );
    CREATE TRIGGER records_no_update BEFORE UPDATE ON records
      BEGIN SELECT RAISE(ABORT, 'records are append-only'); END;
    CREATE TRIGGER records_no_delete BEFORE DELETE ON records
      BEGIN SELECT RAISE(ABORT, 'records are append-only'); END;

    CREATE TABLE investigations (             -- projection
      id TEXT PRIMARY KEY, project TEXT NOT NULL, config_version TEXT NOT NULL,
      overrides TEXT NOT NULL, status TEXT NOT NULL, budget_used INTEGER NOT NULL,
      created REAL NOT NULL, updated REAL NOT NULL);
    CREATE TABLE proposals (                  -- projection
      investigation TEXT NOT NULL, id TEXT NOT NULL, state TEXT NOT NULL,
      experiment TEXT, settings TEXT, updated REAL NOT NULL,
      PRIMARY KEY (investigation, id));

    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, created REAL NOT NULL);
    CREATE TABLE config_versions (
      project TEXT NOT NULL REFERENCES projects(id), version TEXT NOT NULL,
      body TEXT NOT NULL,                     -- the exact bytes that were hashed
      created REAL NOT NULL, PRIMARY KEY (project, version));
    CREATE TABLE blobs (                      -- content-addressed arrays (W-3)
      sha256 TEXT PRIMARY KEY,                -- "sha256:<hex>" of bytes
      media_type TEXT NOT NULL, bytes BLOB NOT NULL, created REAL NOT NULL);
    "#,
];

/// The schema version this build writes.
pub const VERSION: i64 = MIGRATIONS.len() as i64;

fn pragma(conn: &Connection, name: &str) -> Result<i64> {
    Ok(conn.query_row(&format!("PRAGMA {name}"), [], |r| r.get(0))?)
}

/// Initialise an empty file, or bring a workbook to [`VERSION`]. Refuses a
/// SQLite file that is not a workbook and a workbook from a newer format.
pub(crate) fn migrate(conn: &mut Connection, path: &str) -> Result<()> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let (aid, ver) = (pragma(&tx, "application_id")?, pragma(&tx, "user_version")?);
    if aid == 0 && ver == 0 {
        let tables: i64 = tx.query_row("SELECT count(*) FROM sqlite_master", [], |r| r.get(0))?;
        if tables != 0 {
            return Err(Error::Format(format!(
                "{path} is a SQLite database but not an autophys workbook"
            )));
        }
        tx.pragma_update(None, "application_id", APPLICATION_ID)?;
    } else if aid != APPLICATION_ID {
        return Err(Error::Format(format!(
            "{path} is not an autophys workbook (application_id {aid:#x})"
        )));
    }
    if ver > VERSION {
        return Err(Error::Format(format!(
            "{path} has workbook format {ver}; this library reads up to {VERSION}"
        )));
    }
    for (i, sql) in MIGRATIONS.iter().enumerate().skip(ver as usize) {
        tx.execute_batch(sql)?;
        tx.pragma_update(None, "user_version", (i + 1) as i64)?;
    }
    tx.commit()?;
    Ok(())
}
