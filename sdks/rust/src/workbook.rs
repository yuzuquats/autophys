//! One project's workbook (`<slug>.ap-workbook`) and its investigations: the
//! append path, the reads, the approval verbs and verification.
//!
//! A [`Workbook`] owns one read-write connection behind a mutex, so the
//! threads of one process take turns; other processes open their own and
//! SQLite serialises the writers (`BEGIN IMMEDIATE`, 5 s busy timeout). Every
//! append is one transaction, in workbook-format.md's order: validate, replay
//! by id, the investigation exists, the proposal transition, the `edited`
//! limits, then seq, hash, insert and the projection fold.

mod manifest;
pub use manifest::{MAX_DISPLAY_BYTES, StoredDisplay};

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::canonical::{self, GENESIS, canonical, chain_hash};
use crate::error::{Error, Result};
use crate::projections::{self, InvestigationInfo, Proposal};
use crate::records::{self, Logged, Record};
use crate::schema;
use crate::validate::{self, Envelope, Kind};

/// A workbook's one project (`projects` holds exactly this row).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Project {
    pub id: String,
    pub name: String,
}

/// A stored config version: its hash and the parsed body.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ConfigVersion {
    pub version: String,
    pub config: Value,
}

/// The result of an append: the record, its position in this workbook, and
/// whether it is new (`false` for an idempotent replay of an existing id).
/// Serialises as `{record, gseq}`, the daemon's append answer.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Appended {
    pub record: Record,
    pub gseq: i64,
    #[serde(skip)]
    pub created: bool,
}

/// One record whose chain link is broken.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ChainError {
    pub investigation: String,
    pub seq: i64,
    pub id: String,
    /// What is wrong with it (Rust adds this field; Python's has the other three).
    pub problem: String,
}

/// [`Workbook::verify`]'s findings: the same five fields as Python's `wb.verify()`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct VerifyReport {
    pub ok: bool,
    pub records: usize,
    pub investigations: usize,
    pub chain_errors: Vec<ChainError>,
    /// The projection tables equal a fresh replay of the records.
    pub projections_match: bool,
}

/// The last record of one investigation's chain.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Head {
    pub seq: i64,
    pub hash: String,
}

/// Everything in one workbook, read in one transaction. `cursor` is the
/// highest `gseq` in it; [`Workbook::records_after`] resumes from there.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Snapshot {
    pub cursor: i64,
    pub project: Project,
    pub config_versions: Vec<ConfigVersion>,
    pub display: Option<StoredDisplay>,
    pub investigations: Vec<InvestigationInfo>,
    pub proposals: Vec<Proposal>,
    /// Every record in `gseq` order.
    pub records: Vec<Record>,
}

/// Unix seconds at microsecond precision: `floor(ns / 1000) / 1e6`.
pub(crate) fn now_ts() -> f64 {
    let ns = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    (ns / 1000) as f64 / 1e6
}

/// `bytes` random bytes as lowercase hex.
pub(crate) fn random_hex(bytes: usize) -> Result<String> {
    let mut buf = vec![0u8; bytes];
    getrandom::getrandom(&mut buf).map_err(|e| Error::Internal(format!("random: {e}")))?;
    Ok(hex::encode(buf))
}

fn idempotency_conflict(id: &str) -> Error {
    Error::conflict(
        "idempotency_conflict",
        format!("record id {id} was already used for a different record"),
    )
}

/// The most records one [`Investigation::append_batch`] call takes.
pub const MAX_BATCH_RECORDS: usize = 64;

/// One record of an [`Investigation::append_batch`] transaction; also the
/// wire shape of `POST /investigations/{inv}/records` (`{"records": [...]}`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct BatchRecord {
    /// The client's idempotency key, as for a single append.
    pub id: String,
    pub kind: String,
    pub payload: Value,
    /// Top-level payload fields to set to the `hash` of an earlier record of
    /// the same batch (by index), before the record is checked and hashed:
    /// `{"measurement_version": 0}` links a `data_attached` event to the
    /// batch's first record. The fields must be absent from `payload`.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub hash_of: BTreeMap<String, usize>,
}

impl BatchRecord {
    pub fn new(id: impl Into<String>, kind: Kind, payload: Value) -> Self {
        Self { id: id.into(), kind: kind.as_str().into(), payload, hash_of: BTreeMap::new() }
    }
    /// Set payload field `field` to the hash of batch record `index`.
    pub fn hash_of(mut self, field: impl Into<String>, index: usize) -> Self {
        self.hash_of.insert(field.into(), index);
        self
    }
}

/// Batch checks that need no database: count, ids, kinds and links.
pub(crate) fn check_batch(records: &[BatchRecord]) -> Result<Vec<Kind>> {
    if records.is_empty() || records.len() > MAX_BATCH_RECORDS {
        return Err(Error::invalid(
            "records",
            format!("required array of 1 to {MAX_BATCH_RECORDS} records"),
        ));
    }
    let mut kinds = Vec::with_capacity(records.len());
    for (i, r) in records.iter().enumerate() {
        let at = |e: Error| batch_error(i, e);
        validate::check_id("id", &r.id).map_err(at)?;
        if let Some(j) = records[..i].iter().position(|o| o.id == r.id) {
            return Err(Error::invalid(format!("records[{i}].id"), format!("repeats records[{j}].id")));
        }
        let kind = Kind::parse(&r.kind)
            .ok_or_else(|| Error::invalid(format!("records[{i}].kind"), format!("unknown kind {:?}", r.kind)))?;
        if kind == Kind::Investigation {
            return Err(Error::invalid(
                format!("records[{i}].kind"),
                "investigation records are created by create_investigation",
            ));
        }
        for (field, &j) in &r.hash_of {
            let path = format!("records[{i}].hash_of.{field}");
            if j >= i {
                return Err(Error::invalid(path, "must name an earlier record of the batch"));
            }
            match r.payload.as_object() {
                None => return Err(Error::invalid(format!("records[{i}].payload"), "must be an object")),
                Some(p) if p.contains_key(field) => {
                    return Err(Error::invalid(path, "the field is also in the payload"));
                }
                _ => {}
            }
        }
        kinds.push(kind);
    }
    Ok(kinds)
}

/// The attachment guarantee of the removed `…/attachment` route, kept for
/// batches: a `data_attached` event at batch index `i` whose
/// `measurement_version` points into the batch must name a measurement of
/// it, and when measurements precede it in the batch it must name one of
/// them. A measurement is named by its record hash (through `hash_of`, as
/// Rust's `attach_data` sends, or literally) or by its payload `version`
/// (the dataset version Python's `attach_data` sends). `earlier` are the
/// kinds and results of records `0..i`. Events whose batch holds no
/// measurement and whose link names no batch record are not affected.
fn check_attachment_link(
    i: usize,
    r: &BatchRecord,
    payload: &Value,
    earlier: &[Kind],
    out: &[Appended],
) -> Result<()> {
    if payload.get("event").and_then(Value::as_str) != Some("data_attached") {
        return Ok(());
    }
    let link = &payload["measurement_version"];
    if let Some(&j) = r.hash_of.get("measurement_version") {
        if earlier[j] != Kind::Measurement {
            return Err(Error::invalid(
                format!("records[{i}].hash_of.measurement_version"),
                format!("records[{j}] is a {}, not a measurement", earlier[j].as_str()),
            ));
        }
        return Ok(());
    }
    let names = |j: usize| {
        let record = &out[j].record;
        link.as_str() == Some(record.hash.as_str())
            || (earlier[j] == Kind::Measurement
                && record.payload.get("version").is_some_and(|v| v == link))
    };
    let path = format!("records[{i}].payload.measurement_version");
    if let Some(j) = (0..i).find(|&j| names(j)) {
        if earlier[j] != Kind::Measurement {
            return Err(Error::invalid(
                path,
                format!("names records[{j}], a {}, not a measurement", earlier[j].as_str()),
            ));
        }
        return Ok(());
    }
    if earlier.contains(&Kind::Measurement) {
        return Err(Error::invalid(path, "must identify a measurement of this batch"));
    }
    Ok(())
}

/// Point a refusal at batch record `i`: `payload.x` becomes `records[i].payload.x`.
fn batch_error(i: usize, e: Error) -> Error {
    match e {
        Error::Invalid { path, message } => Error::Invalid { path: format!("records[{i}].{path}"), message },
        other => other,
    }
}

fn configure(conn: &Connection) -> Result<()> {
    conn.busy_timeout(Duration::from_secs(5))?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    Ok(())
}

struct Inner {
    path: PathBuf,
    project: Project,
    conn: Option<Mutex<Connection>>,
}

/// One project's workbook. Cheap to clone; clones share the connection.
#[derive(Clone)]
pub struct Workbook {
    inner: Arc<Inner>,
    remote: Option<crate::blocking::Remote>,
}

impl std::fmt::Debug for Workbook {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Workbook")
            .field("path", &self.inner.path)
            .field("project", &self.inner.project.name)
            .finish()
    }
}

impl Workbook {
    pub(crate) fn from_remote(remote: crate::blocking::Remote, project: Project) -> Self {
        Self { inner: Arc::new(Inner { path: PathBuf::new(), project, conn: None }), remote: Some(remote) }
    }
    /// The daemon client of a remote workbook (the blocking facade).
    pub fn remote(&self) -> Option<&crate::blocking::Remote> { self.remote.as_ref() }
    pub(crate) fn remote_investigation(&self, id: &str) -> Investigation {
        Investigation { wb:self.clone(), id:id.into() }
    }

    /// Open the workbook at `path`. With `name`, the file is created when
    /// missing and its project row is inserted when absent; a file that holds
    /// a different project is refused (a slug collision). Without `name` the
    /// file must exist and hold its project. Returns whether the project row
    /// was created by this call.
    pub(crate) fn open(path: &Path, name: Option<&str>) -> Result<(Workbook, bool)> {
        let shown = path.display().to_string();
        if name.is_none() && !path.is_file() {
            return Err(Error::NotFound("workbook"));
        }
        if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
            std::fs::create_dir_all(dir)
                .map_err(|e| Error::Io(format!("create {}: {e}", dir.display())))?;
        }
        let mut conn = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_CREATE
                | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        configure(&conn)?;
        let mode: String = conn.query_row("PRAGMA journal_mode = WAL", [], |r| r.get(0))?;
        if !mode.eq_ignore_ascii_case("wal") {
            return Err(Error::Format(format!(
                "{shown}: journal_mode is {mode}, not wal"
            )));
        }
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        schema::migrate(&mut conn, &shown)?;
        let (project, created) = match name {
            Some(name) => ensure_project_row(&mut conn, &shown, name)?,
            None => (
                read_project(&conn)?
                    .ok_or_else(|| Error::Format(format!("{shown} holds no project row")))?,
                false,
            ),
        };
        Ok((
            Workbook {
                remote: None,
                inner: Arc::new(Inner {
                    path: path.to_path_buf(),
                    project,
                    conn: Some(Mutex::new(conn)),
                }),
            },
            created,
        ))
    }

    fn conn(&self) -> Result<MutexGuard<'_, Connection>> {
        self.inner
            .conn.as_ref().ok_or_else(|| Error::Unsupported("operation requires a local workbook".into()))?
            .lock()
            .map_err(|_| Error::Internal("workbook connection poisoned".into()))
    }

    pub fn path(&self) -> &Path {
        &self.inner.path
    }

    /// The workbook's project (`id` is `prj_` + 16 hex).
    pub fn project(&self) -> &Project {
        &self.inner.project
    }

    pub fn id(&self) -> &str {
        &self.inner.project.id
    }

    pub fn name(&self) -> &str {
        &self.inner.project.name
    }

    // --- config versions -----------------------------------------------------

    /// The project's config versions, oldest first.
    pub fn config_versions(&self) -> Result<Vec<ConfigVersion>> {
        if let Some(r) = &self.remote { return r.config_versions(self.id()); }
        list_configs(&*self.conn()?)
    }

    /// Store `body` as config version `v`. `v` must be `sha256:<hex of body>`
    /// (`hash_mismatch`) and the body JSON. Returns whether it was new;
    /// re-putting identical bytes is a no-op.
    pub fn put_config_version(&self, v: &str, body: &[u8]) -> Result<bool> {
        if let Some(r) = &self.remote { return r.put_config_version(self.id(),v,body); }
        let want = format!("sha256:{}", canonical::sha256_hex([body]));
        if want != v {
            return Err(Error::HashMismatch);
        }
        let text = std::str::from_utf8(body)
            .ok()
            .filter(|t| serde_json::from_str::<Value>(t).is_ok())
            .ok_or_else(|| Error::invalid("$", "the config body must be JSON"))?;
        let mut conn = self.conn()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let n = tx.execute(
            "INSERT OR IGNORE INTO config_versions (project, version, body, created)
             VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![self.id(), v, text, now_ts()],
        )?;
        tx.commit()?;
        Ok(n == 1)
    }

    // --- investigations ------------------------------------------------------

    /// Store exact bytes under a sha256-prefixed content address (format v1).
    pub fn put_blob(&self, data: &[u8], media_type: &str) -> Result<String> {
        if let Some(r) = &self.remote { return r.put_blob(self.id(),data,media_type); }
        let hash = format!("sha256:{}", crate::sha256_hex([data]));
        self.conn()?.execute("INSERT OR IGNORE INTO blobs (sha256, media_type, bytes, created) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![hash, media_type, data, now_ts()])?;
        Ok(hash)
    }
    /// Read a blob by prefixed address or the bare playbook digest.
    pub fn get_blob(&self, hash: &str) -> Result<(Vec<u8>, String)> {
        if let Some(r) = &self.remote { return r.get_blob(self.id(),hash); }
        let hash = if hash.starts_with("sha256:") {
            hash.to_string()
        } else {
            format!("sha256:{hash}")
        };
        self.conn()?
            .query_row(
                "SELECT bytes, media_type FROM blobs WHERE sha256 = ?1",
                [hash],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?
            .ok_or(Error::NotFound("blob"))
    }

    /// Every investigation's projection row, oldest first.
    pub fn investigations(&self) -> Result<Vec<InvestigationInfo>> {
        if let Some(r) = &self.remote { return r.investigations(Some(self.id())); }
        projections::investigations(&*self.conn()?)
    }

    /// The investigation `id`, for its records and the approval verbs.
    pub fn investigation(&self, id: &str) -> Result<Investigation> {
        if let Some(r) = &self.remote { if !r.investigations(Some(self.id()))?.iter().any(|i|i.id==id) { return Err(Error::NotFound("investigation")); }
            return Ok(self.remote_investigation(id)); }
        if !projections::investigation_exists(&*self.conn()?, id)? {
            return Err(Error::NotFound("investigation"));
        }
        Ok(Investigation {
            wb: self.clone(),
            id: id.to_string(),
        })
    }

    /// Append a new investigation's seq-0 record. `meta` is the client's
    /// object; `project_id` (this workbook's, when absent), `config_version`
    /// and `overrides` (default `{}`) are set in it, and the pinned config
    /// version must be stored (`unknown_config_version`). `record_id` is the
    /// idempotency key: replaying it returns the same investigation with
    /// `false`.
    pub fn create_investigation(
        &self,
        meta: Value,
        record_id: Option<&str>,
    ) -> Result<(Investigation, bool)> {
        if let Some(r) = &self.remote { return r.create(self,meta,record_id); }
        let record_id = match record_id {
            Some(id) => {
                validate::check_id("Idempotency-Key", id)?;
                id.to_string()
            }
            None => random_hex(16)?,
        };
        let mut payload = match meta {
            Value::Null => Map::new(),
            Value::Object(m) => m,
            _ => return Err(Error::invalid("meta", "must be an object")),
        };
        match payload.get("overrides") {
            None | Some(Value::Null) => {
                payload.insert("overrides".into(), Value::Object(Map::new()));
            }
            Some(Value::Object(_)) => {}
            Some(_) => return Err(Error::invalid("overrides", "must be an object")),
        }
        match payload.get("project_id") {
            None | Some(Value::Null) => {
                payload.insert("project_id".into(), Value::String(self.id().into()));
            }
            Some(Value::String(p)) if p == self.id() => {}
            Some(_) => return Err(Error::NotFound("project")),
        }
        let payload = Value::Object(payload);
        // A missing pin reads as the request's own field; anything else (a
        // bad `playbook.sha256`, say) keeps the validator's path, as Python.
        validate::payload_shape(Kind::Investigation, &payload).map_err(|e| match e {
            Error::Invalid { ref path, .. }
                if path == "payload.project_id" || path == "payload.config_version" =>
            {
                Error::invalid(
                    "project_id",
                    "project_id and config_version are required strings",
                )
            }
            e => e,
        })?;
        let text = canonical(&payload);
        if text.len() > validate::MAX_PAYLOAD_BYTES {
            return Err(Error::TooLarge(validate::MAX_PAYLOAD_BYTES));
        }
        let version = payload["config_version"].as_str().unwrap_or_default();
        let mut conn = self.conn()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some((existing, stored)) = records::by_id(&tx, &record_id)? {
            if existing.record.kind == Kind::Investigation.as_str() && stored == text {
                drop(tx);
                drop(conn);
                return Ok((
                    Investigation {
                        wb: self.clone(),
                        id: existing.record.investigation,
                    },
                    false,
                ));
            }
            return Err(idempotency_conflict(&record_id));
        }
        let pinned = tx
            .query_row(
                "SELECT 1 FROM config_versions WHERE project = ?1 AND version = ?2",
                [self.id(), version],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        if !pinned {
            return Err(Error::conflict(
                "unknown_config_version",
                "store the config version first",
            ));
        }
        let inv = format!("inv_{}", random_hex(8)?);
        insert_record(&tx, &inv, &record_id, Kind::Investigation, &text)?;
        tx.commit()?;
        drop(conn);
        Ok((
            Investigation {
                wb: self.clone(),
                id: inv,
            },
            true,
        ))
    }

    /// Every proposal's folded state, by investigation.
    pub fn proposals(&self) -> Result<Vec<Proposal>> {
        if let Some(r) = &self.remote { return Ok(r.snapshot(self.id())?.proposals); }
        projections::proposals(&*self.conn()?, None)
    }

    // --- the log -------------------------------------------------------------

    /// The highest `gseq` in this workbook (0 when it has no records).
    pub fn cursor(&self) -> Result<i64> {
        if let Some(r) = &self.remote { return Ok(r.snapshot(self.id())?.cursor); }
        records::cursor(&*self.conn()?)
    }

    /// Up to `limit` records after `gseq`, in `gseq` order (Rust only: the
    /// daemon's `/stream`). `gseq` orders records within this workbook only.
    pub fn records_after(&self, gseq: i64, limit: i64) -> Result<Vec<Logged>> {
        if let Some(r) = &self.remote { return r.records_after(self.id(),gseq,limit,None); }
        records::after(&*self.conn()?, gseq, limit, None)
    }

    /// The whole workbook in one read transaction.
    pub fn snapshot(&self) -> Result<Snapshot> {
        if let Some(r) = &self.remote { return r.snapshot(self.id()); }
        let conn = self.conn()?;
        let tx = conn.unchecked_transaction()?;
        let cursor = records::cursor(&tx)?;
        let snap = Snapshot {
            cursor,
            project: self.project().clone(),
            config_versions: list_configs(&tx)?,
            display: manifest::read(&tx, self.id())?,
            investigations: projections::investigations(&tx)?,
            proposals: projections::proposals(&tx, None)?,
            records: records::after(&tx, 0, cursor, None)?
                .into_iter()
                .map(|l| l.record)
                .collect(),
        };
        tx.finish()?;
        Ok(snap)
    }

    /// `{investigation: Head}` of every chain's last record.
    pub fn heads(&self) -> Result<BTreeMap<String, Head>> {
        if let Some(r) = &self.remote { let _ = r; return self.remote_heads(); }
        let conn = self.conn()?;
        let mut stmt = conn.prepare(
            "SELECT investigation, seq, hash FROM records r
              WHERE seq = (SELECT MAX(seq) FROM records WHERE investigation = r.investigation)
              ORDER BY investigation",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                Head {
                    seq: r.get(1)?,
                    hash: r.get(2)?,
                },
            ))
        })?;
        rows.map(|r| r.map_err(Error::from)).collect()
    }

    /// The projection rows as stored, shaped like the conformance files.
    pub fn projection_rows(&self) -> Result<Value> {
        if let Some(r) = &self.remote { let _ = r; return self.remote_projection_rows(); }
        projections::rows(&*self.conn()?)
    }

    // --- integrity -----------------------------------------------------------

    /// Verify every chain (seq, `prev_hash`, canonical payload text, hash) and
    /// that the projection tables equal a fresh replay of the records. The
    /// file is not changed.
    pub fn verify(&self) -> Result<VerifyReport> {
        if let Some(r) = &self.remote { let _ = r; return self.remote_verify(); }
        let conn = self.conn()?;
        let tx = conn.unchecked_transaction()?;
        let replay = Connection::open_in_memory()?;
        projections::create_tables(&replay)?;
        let mut stmt = tx.prepare(&format!(
            "SELECT {} FROM records ORDER BY gseq",
            records::COLUMNS
        ))?;
        let mut rows = stmt.query([])?;
        let mut heads: BTreeMap<String, (i64, String)> = BTreeMap::new();
        let (mut count, mut chain_errors) = (0usize, Vec::new());
        while let Some(row) = rows.next()? {
            let (l, text) = records::from_row(row)?;
            let r = l.record;
            count += 1;
            let (seq, prev) = heads
                .get(&r.investigation)
                .cloned()
                .unwrap_or((-1, GENESIS.to_string()));
            let mut problems = Vec::new();
            if r.seq != seq + 1 {
                problems.push(format!("seq {} where {} was expected", r.seq, seq + 1));
            }
            if r.prev_hash != prev {
                problems.push("prev_hash does not match the previous record's hash".to_string());
            }
            if canonical(&r.payload) != text {
                problems.push("stored payload is not canonical JSON".to_string());
            }
            if chain_hash(&prev, &r.id, &r.kind, &r.payload) != r.hash {
                problems.push(
                    "hash does not match sha256(prev_hash || canonical{id, kind, payload})".into(),
                );
            }
            if !problems.is_empty() {
                chain_errors.push(ChainError {
                    investigation: r.investigation.clone(),
                    seq: r.seq,
                    id: r.id.clone(),
                    problem: problems.join("; "),
                });
            }
            projections::apply(&replay, &r)?;
            heads.insert(r.investigation.clone(), (r.seq, r.hash.clone()));
        }
        drop(rows);
        drop(stmt);
        let projections_match = projections::dump(&tx)? == projections::dump(&replay)?;
        tx.finish()?;
        Ok(VerifyReport {
            ok: chain_errors.is_empty() && projections_match,
            records: count,
            investigations: heads.len(),
            chain_errors,
            projections_match,
        })
    }

    /// Replace the projection tables by a replay of the records (they are
    /// derived data; the records are never changed), then verify.
    pub fn rebuild_projections(&self) -> Result<VerifyReport> {
        {
            let mut conn = self.conn()?;
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            projections::rebuild(&tx)?;
            tx.commit()?;
        }
        self.verify()
    }

    /// Open a second, read-only connection to this file (for watching).
    fn watcher(&self) -> Result<Connection> {
        let conn = Connection::open_with_flags(
            &self.inner.path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        configure(&conn)?;
        Ok(conn)
    }
}

fn read_project(conn: &Connection) -> Result<Option<Project>> {
    let mut stmt = conn.prepare("SELECT id, name FROM projects ORDER BY created, id")?;
    let mut rows = stmt.query_map([], |r| {
        Ok(Project {
            id: r.get(0)?,
            name: r.get(1)?,
        })
    })?;
    match rows.next() {
        Some(p) => {
            let project = p?;
            if rows.next().is_some() {
                return Err(Error::Format(
                    "a workbook must hold exactly one project row".into(),
                ));
            }
            Ok(Some(project))
        }
        None => Ok(None),
    }
}

fn ensure_project_row(conn: &mut Connection, shown: &str, name: &str) -> Result<(Project, bool)> {
    if name.trim().is_empty() || name.chars().count() > 200 {
        return Err(Error::invalid(
            "name",
            "required string of 1 to 200 characters",
        ));
    }
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if let Some(p) = read_project(&tx)? {
        if p.name != name {
            return Err(Error::conflict(
                "conflict",
                format!("{shown} holds project {:?}, not {name:?}", p.name),
            ));
        }
        return Ok((p, false));
    }
    let id = format!("prj_{}", random_hex(8)?);
    tx.execute(
        "INSERT INTO projects (id, name, created) VALUES (?1, ?2, ?3)",
        rusqlite::params![id, name, now_ts()],
    )?;
    tx.commit()?;
    Ok((
        Project {
            id,
            name: name.to_string(),
        },
        true,
    ))
}

fn list_configs(conn: &Connection) -> Result<Vec<ConfigVersion>> {
    let mut stmt =
        conn.prepare_cached("SELECT version, body FROM config_versions ORDER BY created, version")?;
    let rows = stmt.query_map([], |r| {
        let body: String = r.get(1)?;
        Ok(ConfigVersion {
            version: r.get(0)?,
            config: serde_json::from_str(&body).unwrap_or(Value::Null),
        })
    })?;
    rows.map(|r| r.map_err(Error::from)).collect()
}

/// If `id` exists: the stored record when it is the same record (replay),
/// else `idempotency_conflict`. `None` when the id is new.
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

/// Chain, insert and fold one record inside the caller's transaction.
fn insert_record(conn: &Connection, inv: &str, id: &str, kind: Kind, text: &str) -> Result<Logged> {
    let (seq, prev) = match records::head(conn, inv)? {
        Some((seq, hash)) => (seq + 1, hash),
        None => (0, GENESIS.to_string()),
    };
    let payload: Value = serde_json::from_str(text)
        .map_err(|e| Error::Internal(format!("canonical payload reparse: {e}")))?;
    let hash = chain_hash(&prev, id, kind.as_str(), &payload);
    let record = Record {
        id: id.to_string(),
        investigation: inv.to_string(),
        seq,
        kind: kind.as_str().to_string(),
        ts: now_ts(),
        payload,
        prev_hash: prev,
        hash,
    };
    let gseq = records::insert(conn, &record, text)?;
    projections::apply(conn, &record)?;
    Ok(Logged { gseq, record })
}

/// One investigation in a workbook: its records and the approval verbs.
#[derive(Clone, Debug)]
pub struct Investigation {
    wb: Workbook,
    /// `inv_` + 16 hex.
    pub id: String,
}

impl Investigation {
    pub fn workbook(&self) -> &Workbook {
        &self.wb
    }

    /// The investigation's projection row now.
    pub fn info(&self) -> Result<InvestigationInfo> {
        if let Some(r) = &self.wb.remote { return r.investigations(Some(self.wb.id()))?.into_iter().find(|i|i.id==self.id).ok_or(Error::NotFound("investigation")); }
        projections::investigations(&*self.wb.conn()?)?
            .into_iter()
            .find(|i| i.id == self.id)
            .ok_or(Error::NotFound("investigation"))
    }

    /// Append a record of `kind` (any kind but `investigation`). `id` is the
    /// client's idempotency key (32 random hex when `None`): replaying it with
    /// the same kind and payload returns the stored record with
    /// `created = false`; the same id with other content is
    /// `idempotency_conflict`.
    pub fn append(&self, kind: &str, payload: Value, id: Option<&str>) -> Result<Appended> {
        if let Some(r) = &self.wb.remote { return r.append(&self.id,kind,payload,id); }
        let kind = Kind::parse(kind)
            .ok_or_else(|| Error::invalid("kind", format!("unknown kind {kind:?}")))?;
        if kind == Kind::Investigation {
            return Err(Error::BadRequest(
                "investigation records are created by create_investigation".into(),
            ));
        }
        let id = match id {
            Some(id) => {
                validate::check_id("id", id)?;
                id.to_string()
            }
            None => random_hex(16)?,
        };
        validate::payload_shape(kind, &payload)?;
        let text = canonical(&payload);
        if text.len() > validate::MAX_PAYLOAD_BYTES {
            return Err(Error::TooLarge(validate::MAX_PAYLOAD_BYTES));
        }
        let env = Envelope { id, kind, payload };
        let mut conn = self.wb.conn()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(replayed) = replay(&tx, &env.id, &self.id, kind, &text)? {
            return Ok(replayed);
        }
        if !projections::investigation_exists(&tx, &self.id)? {
            return Err(Error::NotFound("investigation"));
        }
        projections::check(&tx, &self.id, &env)?;
        let logged = insert_record(&tx, &self.id, &env.id, kind, &text)?;
        tx.commit()?;
        Ok(Appended {
            gseq: logged.gseq,
            record: logged.record,
            created: true,
        })
    }

    /// The investigation's records in seq order, optionally one kind only.
    pub fn records(&self, kind: Option<&str>) -> Result<Vec<Record>> {
        if let Some(r) = &self.wb.remote { return r.records(&self.id,kind); }
        if let Some(k) = kind {
            Kind::parse(k).ok_or_else(|| Error::invalid("kind", format!("unknown kind {k:?}")))?;
        }
        let conn = self.wb.conn()?;
        if !projections::investigation_exists(&conn, &self.id)? {
            return Err(Error::NotFound("investigation"));
        }
        records::of_investigation(&conn, &self.id, kind)
    }

    /// This investigation's records after workbook position `gseq`, in order
    /// (Rust only: `/stream?investigation=` and `…/records?after=`).
    pub fn records_after(&self, gseq: i64) -> Result<Vec<Logged>> {
        if let Some(r) = &self.wb.remote { return r.records_after(self.wb.id(),gseq,i64::MAX,Some(&self.id)); }
        records::after(&*self.wb.conn()?, gseq, i64::MAX, Some(&self.id))
    }

    /// Proposal `pid`'s folded state.
    pub fn proposal(&self, pid: &str) -> Result<Proposal> {
        if let Some(r) = &self.wb.remote { return r.proposal(&self.id,pid); }
        proposal_in(&*self.wb.conn()?, &self.id, pid)
    }

    /// Approve proposal `pid` as proposed, or, with `settings`, as edited
    /// (each setting that is an outlook axis must stay inside the axis; the
    /// others must keep their proposed values).
    pub fn approve(&self, pid: &str, by: &str, settings: Option<Value>) -> Result<Appended> {
        let mut payload = serde_json::json!({
            "proposal_id": pid,
            "event": if settings.is_some() { "edited" } else { "approved" },
            "by": by,
        });
        if let Some(s) = settings {
            payload["settings"] = s;
        }
        self.append("proposal", payload, None)
    }

    /// Reject proposal `pid`.
    pub fn reject(&self, pid: &str, by: &str, reason: &str) -> Result<Appended> {
        self.append(
            "proposal",
            serde_json::json!({"proposal_id": pid, "event": "rejected", "by": by, "reason": reason}),
            None,
        )
    }

    /// Record the measurement taken for approved proposal `pid`: a
    /// `measurement` record `{observation}`, then the proposal's
    /// `data_attached` event, whose `measurement_version` is that
    /// measurement record's hash. Both records commit in one transaction
    /// ([`Investigation::append_batch`]). Returns the `data_attached` record.
    ///
    /// Over HTTP the two record ids derive from the investigation, the
    /// proposal and the kind, so a retry after a lost response replays the
    /// committed pair, and a different observation for the same proposal is
    /// `idempotency_conflict`.
    pub fn attach_data(&self, pid: &str, observation: Value) -> Result<Appended> {
        validate::check_id("payload.proposal_id", pid)?;
        let (measurement_id, event_id) = if self.wb.remote.is_some() {
            let identity = |kind: &str| {
                crate::sha256_hex([canonical(&serde_json::json!({
                    "investigation": self.id, "proposal_id": pid, "kind": kind
                }))
                .as_bytes()])
            };
            (identity("measurement"), identity("proposal"))
        } else {
            (random_hex(16)?, random_hex(16)?)
        };
        let batch = [
            BatchRecord::new(
                measurement_id,
                Kind::Measurement,
                serde_json::json!({"observation": observation}),
            ),
            BatchRecord::new(
                event_id,
                Kind::Proposal,
                serde_json::json!({"proposal_id": pid, "event": "data_attached"}),
            )
            .hash_of("measurement_version", 0),
        ];
        let mut out = self.append_batch(&batch)?;
        out.pop()
            .ok_or_else(|| Error::Internal("empty batch result".into()))
    }

    /// Append `records` to this investigation in order, all or none, in one
    /// `BEGIN IMMEDIATE` transaction (`POST /investigations/{inv}/records`
    /// over HTTP). Each record is checked exactly as [`Investigation::append`]
    /// checks one, against the state the earlier records of the batch leave:
    /// a record whose id is stored with the same kind and payload replays
    /// (`created = false`), the same id with other content is
    /// `idempotency_conflict`, and the proposal state machine applies. Any
    /// refusal writes nothing. A record's [`BatchRecord::hash_of`] fills
    /// top-level payload fields with the hash of an earlier record of the
    /// batch before it is checked. One check spans records: a `data_attached`
    /// event linking into the batch must name a measurement, and with
    /// measurements in the batch it must name one of them (by hash, or by
    /// payload `version` as Python sends). Returns one [`Appended`] per record.
    pub fn append_batch(&self, records: &[BatchRecord]) -> Result<Vec<Appended>> {
        if let Some(r) = &self.wb.remote {
            return r.append_batch(&self.id, records);
        }
        let kinds = check_batch(records)?;
        let batch_kinds = kinds.clone();
        let mut conn = self.wb.conn()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if !projections::investigation_exists(&tx, &self.id)? {
            return Err(Error::NotFound("investigation"));
        }
        let mut out: Vec<Appended> = Vec::with_capacity(records.len());
        for (i, (r, kind)) in records.iter().zip(kinds).enumerate() {
            let at = |e: Error| batch_error(i, e);
            let mut payload = r.payload.clone();
            if let Some(fields) = payload.as_object_mut() {
                for (field, &j) in &r.hash_of {
                    fields.insert(field.clone(), Value::String(out[j].record.hash.clone()));
                }
            }
            validate::payload_shape(kind, &payload).map_err(at)?;
            check_attachment_link(i, r, &payload, &batch_kinds[..i], &out)?;
            let text = canonical(&payload);
            if text.len() > validate::MAX_PAYLOAD_BYTES {
                return Err(Error::TooLarge(validate::MAX_PAYLOAD_BYTES));
            }
            if let Some(replayed) = replay(&tx, &r.id, &self.id, kind, &text).map_err(at)? {
                out.push(replayed);
                continue;
            }
            let env = Envelope { id: r.id.clone(), kind, payload };
            projections::check(&tx, &self.id, &env).map_err(at)?;
            let logged = insert_record(&tx, &self.id, &env.id, kind, &text)?;
            out.push(Appended { gseq: logged.gseq, record: logged.record, created: true });
        }
        tx.commit()?;
        Ok(out)
    }

    /// Block until proposal `proposal_id` leaves `proposed`, whoever decides
    /// it: this process, the browser through the daemon, or another process
    /// on the same file. Returns its current state immediately if already
    /// decided. The file is re-read when `PRAGMA data_version` changes.
    /// Unknown ids return `NotFound`; pending decisions time out after `timeout`.
    pub fn wait_for_approval(&self, proposal_id: &str, timeout: Duration) -> Result<Proposal> {
        if let Some(r) = &self.wb.remote { return r.wait_for_approval(&self.id,proposal_id,timeout); }
        let watch = self.wb.watcher()?;
        let deadline = Instant::now() + timeout;
        let mut seen: Option<i64> = None;
        loop {
            let version: i64 = watch.query_row("PRAGMA data_version", [], |r| r.get(0))?;
            if seen != Some(version) {
                seen = Some(version);
                let p = proposal_in(&watch, &self.id, proposal_id)?;
                if p.status != "proposed" {
                    return Ok(p);
                }
            }
            let now = Instant::now();
            if now >= deadline {
                return Err(Error::Timeout(format!(
                    "proposal {} still awaiting approval",
                    proposal_id
                )));
            }
            std::thread::sleep(WATCH_INTERVAL.min(deadline - now));
        }
    }
}

/// How often `wait_for_approval` checks `PRAGMA data_version`.
const WATCH_INTERVAL: Duration = Duration::from_millis(100);

fn proposal_in(conn: &Connection, inv: &str, pid: &str) -> Result<Proposal> {
    if !projections::investigation_exists(conn, inv)? {
        return Err(Error::NotFound("investigation"));
    }
    projections::proposals(conn, Some((inv, pid)))?
        .into_iter()
        .next()
        .ok_or(Error::NotFound("proposal"))
}
