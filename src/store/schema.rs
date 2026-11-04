//! Migrations, keyed by `PRAGMA user_version`. Append a step; never edit one
//! that has shipped.

use rusqlite::Connection;

use crate::store::error::Result;

const MIGRATIONS: &[&str] = &[
    // 1: the log, its projections, reference data, keys and pairings.
    r#"
    -- the log: the only table that is ever the source of truth
    CREATE TABLE records (
      gseq          INTEGER PRIMARY KEY,      -- global order; the SSE cursor
      id            TEXT NOT NULL UNIQUE,     -- client-chosen, = Idempotency-Key
      investigation TEXT NOT NULL,
      seq           INTEGER NOT NULL,         -- per-investigation order, from 0
      kind          TEXT NOT NULL,
      ts            REAL NOT NULL,            -- unix seconds, as the SDK's Record.ts
      payload       TEXT NOT NULL,            -- canonical JSON
      prev_hash     TEXT NOT NULL,
      hash          TEXT NOT NULL,
      UNIQUE (investigation, seq)
    );
    CREATE TRIGGER records_no_update BEFORE UPDATE ON records
      BEGIN SELECT RAISE(ABORT, 'records are append-only'); END;
    CREATE TRIGGER records_no_delete BEFORE DELETE ON records
      BEGIN SELECT RAISE(ABORT, 'records are append-only'); END;

    -- projections: rebuildable from records (db_check(rebuild = true))
    CREATE TABLE investigations (
      id             TEXT PRIMARY KEY,
      project        TEXT NOT NULL,
      config_version TEXT NOT NULL,
      overrides      TEXT NOT NULL,           -- canonical JSON
      status         TEXT NOT NULL,
      budget_used    INTEGER NOT NULL,
      created        REAL NOT NULL,
      updated        REAL NOT NULL
    );
    CREATE TABLE proposals (
      investigation TEXT NOT NULL,
      id            TEXT NOT NULL,
      state         TEXT NOT NULL,
      experiment    TEXT,
      settings      TEXT,                     -- canonical JSON or NULL
      updated       REAL NOT NULL,
      PRIMARY KEY (investigation, id)
    );

    -- reference data, written directly
    CREATE TABLE projects (
      id      TEXT PRIMARY KEY,
      name    TEXT NOT NULL UNIQUE,
      created REAL NOT NULL
    );
    CREATE TABLE config_versions (
      project TEXT NOT NULL REFERENCES projects(id),
      version TEXT NOT NULL,
      body    TEXT NOT NULL,                  -- the exact bytes that were hashed
      created REAL NOT NULL,
      PRIMARY KEY (project, version)
    );
    CREATE TABLE keys (
      id        TEXT PRIMARY KEY,
      device    TEXT NOT NULL,
      sha256    TEXT NOT NULL UNIQUE,         -- never the key itself
      created   TEXT NOT NULL,
      last_used TEXT,
      revoked   TEXT
    );
    CREATE TABLE pairings (
      device_code_sha256 TEXT PRIMARY KEY,    -- never the device code itself
      user_code    TEXT NOT NULL,
      device       TEXT NOT NULL,
      client       TEXT NOT NULL,
      state        TEXT NOT NULL,             -- pending | approved | denied | issued
      created      TEXT NOT NULL,
      expires      TEXT NOT NULL,
      last_poll_ms INTEGER,
      key_id       TEXT
    );
    CREATE UNIQUE INDEX pairings_open_user_code ON pairings(user_code)
      WHERE state IN ('pending', 'approved');
    "#,
];

/// Bring the database to the latest schema, one transaction per step.
pub fn migrate(conn: &mut Connection) -> Result<()> {
    let current: usize =
        conn.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))? as usize;
    for (i, sql) in MIGRATIONS.iter().enumerate().skip(current) {
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        tx.pragma_update(None, "user_version", (i + 1) as i64)?;
        tx.commit()?;
    }
    Ok(())
}

/// The schema version this build writes.
pub const VERSION: usize = MIGRATIONS.len();
