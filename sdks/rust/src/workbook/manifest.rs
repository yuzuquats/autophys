//! Project presentation data (workbook format 2); independent of records and
//! config hashes.
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
    /// Returns (latest, changed); an identical canonical body keeps the stored
    /// row. The first display write moves the workbook to format 2 in the
    /// same transaction (DM-D1); SDK 0.1.x cannot open it afterwards.
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
        // The display table is workbook format 2 (DM-D1). The first display
        // write moves the workbook there, in this transaction, so a failure
        // leaves format 1; an unchanged body still commits the upgrade.
        crate::schema::upgrade(&tx, &self.path().display().to_string(), crate::schema::VERSION)?;
        if let Some(old) = read(&tx, self.id())? {
            if old.digest == digest {
                tx.commit()?;
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

    /// No manifest is represented by None. Reads format 2, and format-1
    /// workbooks holding the older optional table, alike; reading never
    /// creates the table or changes the format.
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
