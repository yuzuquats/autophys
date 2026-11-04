//! Optional project presentation data; independent of records and config hashes.
use super::*;

/// Maximum uploaded and canonical display size (256 KiB).
pub const MAX_DISPLAY_BYTES: usize = 256 * 1024;

/// The latest manifest for one project. The digest names its canonical bytes.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct StoredDisplay {
    pub digest: String,
    pub body: Value,
    pub created: f64,
}

impl Workbook {
    /// Validate only format 1, canonicalise, then replace the project's display.
    /// Returns (latest, changed); an identical canonical body is a no-op.
    pub fn put_display(&self, body: &[u8]) -> Result<(StoredDisplay, bool)> {
        if let Some(r) = self.remote() { return r.put_display(self.id(),body); }
        if body.len() > MAX_DISPLAY_BYTES {
            return Err(Error::TooLarge(MAX_DISPLAY_BYTES));
        }
        let value: Value = serde_json::from_slice(body)
            .map_err(|e| Error::invalid("$", format!("the manifest must be JSON: {e}")))?;
        if !value.is_object() || value.get("format").and_then(Value::as_u64) != Some(1) {
            return Err(Error::invalid(
                "format",
                "expected display manifest format 1",
            ));
        }
        let text = canonical(&value);
        if text.len() > MAX_DISPLAY_BYTES {
            return Err(Error::TooLarge(MAX_DISPLAY_BYTES));
        }
        let digest = canonical::sha256_hex([text.as_bytes()]);
        let mut conn = self.conn()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        // An optional extension to format 1: old readers preserve unknown
        // tables. Do not bump user_version and strand current Python readers.
        tx.execute_batch(
            "CREATE TABLE IF NOT EXISTS display (
              project TEXT PRIMARY KEY REFERENCES projects(id),
              digest TEXT NOT NULL, body TEXT NOT NULL, created REAL NOT NULL
            );",
        )?;
        if let Some(old) = read(&tx, self.id())? {
            if old.digest == digest {
                return Ok((old, false));
            }
        }
        let created = now_ts();
        tx.execute(
            "INSERT INTO display (project, digest, body, created) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(project) DO UPDATE SET
               digest = excluded.digest, body = excluded.body, created = excluded.created",
            rusqlite::params![self.id(), digest, text, created],
        )?;
        tx.commit()?;
        Ok((
            StoredDisplay {
                digest,
                body: value,
                created,
            },
            true,
        ))
    }

    /// No manifest is represented by None; reading an old workbook adds no table.
    pub fn display(&self) -> Result<Option<StoredDisplay>> {
        if let Some(r) = self.remote() { return Ok(r.snapshot(self.id())?.display); }
        read(&*self.conn()?, self.id())
    }
}

pub(super) fn read(conn: &Connection, project: &str) -> Result<Option<StoredDisplay>> {
    let exists: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'display')",
        [],
        |r| r.get(0),
    )?;
    if !exists {
        return Ok(None);
    }
    let row: Option<(String, String, f64)> = conn
        .query_row(
            "SELECT digest, body, created FROM display WHERE project = ?1",
            [project],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    row.map(|(digest, text, created)| {
        let body = serde_json::from_str(&text)
            .map_err(|e| Error::Format(format!("stored display is not JSON: {e}")))?;
        Ok(StoredDisplay {
            digest,
            body,
            created,
        })
    })
    .transpose()
}
