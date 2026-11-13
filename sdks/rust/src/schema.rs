//! The `.ap-workbook` schema (workbook-format.md, formats 1 to 3) and its
//! migrations, keyed by `PRAGMA user_version`. Append a step; never edit one
//! that has shipped.
//!
//! A new workbook is created at [`INITIAL_VERSION`]. Later steps run only
//! when a write needs them ([`upgrade`], inside that write's transaction),
//! never on open (DM-D1a): format 2 adds the display table and is reached at
//! a workbook's first display write, so a workbook without a display stays
//! format 1 and readable by SDK 0.1.x. Format 3 adds the overviews table
//! (OV-2) and is reached only at a workbook's first overview write; a display
//! write moves a workbook to exactly [`DISPLAY_VERSION`], never further.

use rusqlite::{Connection, Transaction, TransactionBehavior};

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
    // 1 -> 2: the display table (DM-D1).
    DISPLAY_DDL,
    // 2 -> 3: the append-only project overviews (OV-1).
    OVERVIEWS_DDL,
];

/// The display table. These bytes are the statement SDKs before format 2 ran
/// on a format-1 workbook as an optional extension, and the Python SDK's
/// `_DISPLAY_DDL`, so every SDK leaves the same text in `sqlite_master`.
/// `IF NOT EXISTS` because such a format-1 workbook may already hold it.
const DISPLAY_DDL: &str = "CREATE TABLE IF NOT EXISTS display (\n              project TEXT PRIMARY KEY REFERENCES projects(id),\n              digest TEXT NOT NULL, body TEXT NOT NULL, created REAL NOT NULL\n            );";

/// The overviews table (OV-1). These bytes are the Python SDK's
/// `_OVERVIEWS_DDL` and the `ddl` of `tests/conformance/overview/cases.json`,
/// so every SDK leaves the same text in `sqlite_master`. Rows are only ever
/// inserted; the latest version is the highest `seq`.
const OVERVIEWS_DDL: &str = "CREATE TABLE IF NOT EXISTS overviews (\n  seq INTEGER PRIMARY KEY,\n  project TEXT NOT NULL REFERENCES projects(id),\n  digest TEXT NOT NULL,\n  markdown TEXT NOT NULL,\n  author TEXT NOT NULL,\n  created REAL NOT NULL\n);";

/// `PRAGMA user_version` of a newly created workbook.
pub const INITIAL_VERSION: i64 = 1;

/// The format a display write needs. A display write upgrades to exactly
/// this, so a display-only workbook stays readable by SDKs that read up to
/// format 2 (OV-2); a workbook already past it is left as it is.
pub const DISPLAY_VERSION: i64 = 2;

/// The format an overview write needs (the overviews table).
pub const OVERVIEW_VERSION: i64 = 3;

/// The newest workbook format this build reads and writes.
pub const VERSION: i64 = MIGRATIONS.len() as i64;

const _: () = assert!(
    INITIAL_VERSION == 1 && DISPLAY_VERSION == 2 && OVERVIEW_VERSION == 3 && VERSION == 3
);

fn pragma(conn: &Connection, name: &str) -> Result<i64> {
    Ok(conn.query_row(&format!("PRAGMA {name}"), [], |r| r.get(0))?)
}

/// Initialise an empty file at [`INITIAL_VERSION`], or accept a workbook of
/// any format up to [`VERSION`] as it is. Refuses a SQLite file that is not a
/// workbook and a workbook from a newer format. Never runs a step past
/// [`INITIAL_VERSION`]; [`upgrade`] does, inside the write that needs it.
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
    run_steps(&tx, ver, INITIAL_VERSION)?;
    tx.commit()?;
    Ok(())
}

/// Bring the workbook in the caller's write transaction to format `target`.
/// The steps, the new `user_version` and the write that needed them commit
/// or roll back together. Refuses a format newer than [`VERSION`], also when
/// another process wrote it after this connection opened.
pub(crate) fn upgrade(tx: &Transaction<'_>, path: &str, target: i64) -> Result<()> {
    let ver = pragma(tx, "user_version")?;
    if ver > VERSION {
        return Err(Error::Format(format!(
            "{path} has workbook format {ver}; this library reads up to {VERSION}"
        )));
    }
    run_steps(tx, ver, target)
}

fn run_steps(tx: &Transaction<'_>, from: i64, to: i64) -> Result<()> {
    for step in from.max(0)..to {
        tx.execute_batch(MIGRATIONS[step as usize])?;
        tx.pragma_update(None, "user_version", step + 1)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    /// The table every SDK creates is byte-for-byte the shared vector.
    #[test]
    fn overviews_ddl_is_the_shared_vector() {
        let cases: serde_json::Value = serde_json::from_str(include_str!(
            "../../../tests/conformance/overview/cases.json"
        ))
        .unwrap();
        assert_eq!(super::OVERVIEWS_DDL, cases["ddl"].as_str().unwrap());
    }
}
