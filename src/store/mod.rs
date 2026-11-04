//! The store: one SQLite file holding the append-only record log, its
//! projections, reference data, keys and pairings.
//!
//! Concurrency: one writer thread owns the only read-write connection and
//! runs jobs sent over a channel, so writes are serial and each append is one
//! transaction. Reads run on a small pool of read-only WAL connections under
//! `spawn_blocking`. A record is broadcast to subscribers by the writer thread
//! right after its commit, so the broadcast order is the `gseq` order. No web
//! framework type appears here or in its submodules.

pub mod canonical;
pub mod error;
pub mod keys;
pub mod projections;
pub mod records;
pub mod schema;
pub mod validate;

use std::panic::AssertUnwindSafe;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::{DateTime, Utc};
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde::Serialize;
use serde_json::Value;
use tokio::sync::{broadcast, oneshot};

pub use canonical::{GENESIS, canonical, chain_hash};
pub use error::{Result, StoreError};
pub use keys::{IssuedKey, KeyInfo, PairStart, Pairing};
pub use projections::{Investigation, Proposal};
pub use records::{Logged, Record};
pub use validate::{Envelope, Event, Kind};

/// Settings a daemon may change; [`Options::default`] suits `autophys serve`.
#[derive(Clone, Debug)]
pub struct Options {
    /// Reported by `whoami` and `pair_poll` (single-user daemon).
    pub account: String,
    pub workspace: String,
    /// Where a person approves a device code; shown by the SDK's `pair`.
    pub verification_url: String,
    /// How long a device code stays valid.
    pub pairing_ttl: Duration,
    /// The poll interval handed to the device; faster polls get `slow_down`.
    pub poll_interval: Duration,
    /// Host names (no port) besides loopback literals and `*.localhost` whose
    /// same-origin browser *reads* may skip the key (`/workspace`, `/stream`,
    /// `GET /pairings`).
    pub browser_hosts: Vec<String>,
    /// Origins besides the daemon's own (`http://127.0.0.1:<port>`,
    /// `http://localhost:<port>`, `http://[::1]:<port>`) whose keyless
    /// *writes* are admitted (O-3). Empty by default; a tento.localhost proxy
    /// origin such as `http://autophys.rwc-dev-01.tento.localhost` must be
    /// listed here to approve from the dashboard.
    pub browser_origins: Vec<String>,
    /// Read-only connections kept open for reuse.
    pub readers: usize,
    /// Buffered records per SSE subscriber before it must resync from the DB.
    pub broadcast_capacity: usize,
}

impl Default for Options {
    fn default() -> Self {
        Options {
            account: "local".into(),
            workspace: "local".into(),
            verification_url: "http://127.0.0.1:4794/pair".into(),
            pairing_ttl: Duration::from_secs(600),
            poll_interval: Duration::from_secs(5),
            browser_hosts: Vec::new(),
            browser_origins: Vec::new(),
            readers: 4,
            broadcast_capacity: 1024,
        }
    }
}

/// A project (`GET/POST /projects`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Project {
    pub id: String,
    pub name: String,
}

/// A stored config version (`GET /projects/{pid}/config_versions`).
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ConfigVersion {
    pub version: String,
    pub config: Value,
}

/// A config version with its project, as `/workspace` lists them.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ProjectConfig {
    pub project_id: String,
    pub version: String,
    pub config: Value,
}

/// `POST /investigations` body.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct NewInvestigation {
    pub project_id: String,
    pub config_version: String,
    pub overrides: Value,
    pub meta: Value,
}

/// The result of an append: the record, its cursor, and whether it is new
/// (`false` for an idempotent replay of an existing client id).
#[derive(Clone, Debug, PartialEq)]
pub struct Appended {
    pub gseq: i64,
    pub record: Record,
    pub created: bool,
}

/// `GET /workspace`: everything the browser needs in one consistent snapshot.
/// Resume the stream with `GET /stream?after={cursor}`.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Workspace {
    pub cursor: i64,
    pub projects: Vec<Project>,
    pub config_versions: Vec<ProjectConfig>,
    pub investigations: Vec<Investigation>,
    pub proposals: Vec<Proposal>,
    /// Every record in `gseq` order.
    pub records: Vec<Record>,
}

/// One broken link found by [`Store::db_check`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ChainError {
    pub investigation: String,
    pub seq: i64,
    pub id: String,
    pub problem: String,
}

/// [`Store::db_check`]'s findings.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct CheckReport {
    pub records: usize,
    pub investigations: usize,
    pub chain_errors: Vec<ChainError>,
    /// The projection tables equal a fresh replay of the log.
    pub projections_match: bool,
    /// The projections were replaced by the replay (`rebuild = true`).
    pub rebuilt: bool,
}

impl CheckReport {
    pub fn ok(&self) -> bool {
        self.chain_errors.is_empty() && (self.projections_match || self.rebuilt)
    }
}

type Job = Box<dyn FnOnce(&mut Connection) + Send>;

pub(crate) struct Inner {
    path: PathBuf,
    opts: Options,
    writer: mpsc::Sender<Job>,
    readers: Mutex<Vec<Connection>>,
    pub(crate) bus: broadcast::Sender<Arc<Logged>>,
}

/// The store. Cheap to clone; every clone shares the writer and the pool.
#[derive(Clone)]
pub struct Store {
    pub(crate) inner: Arc<Inner>,
}

impl std::fmt::Debug for Store {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Store")
            .field("path", &self.inner.path)
            .finish()
    }
}

pub(crate) fn now() -> DateTime<Utc> {
    Utc::now()
}

pub(crate) fn ts_of(t: DateTime<Utc>) -> f64 {
    t.timestamp_micros() as f64 / 1e6
}

fn configure_conn(conn: &Connection) -> Result<()> {
    conn.busy_timeout(Duration::from_secs(5))?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    Ok(())
}

impl Store {
    /// Open (creating if needed) the database at `path` with default options.
    pub fn open(path: impl AsRef<Path>) -> Result<Store> {
        Store::open_with(path, Options::default())
    }

    /// Open with explicit [`Options`]: WAL mode, migrations, writer thread.
    pub fn open_with(path: impl AsRef<Path>, opts: Options) -> Result<Store> {
        let path = path.as_ref().to_path_buf();
        if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
            std::fs::create_dir_all(dir)
                .map_err(|e| StoreError::Internal(format!("create {}: {e}", dir.display())))?;
        }
        let mut conn = Connection::open(&path)?;
        configure_conn(&conn)?;
        let mode: String = conn.query_row("PRAGMA journal_mode = WAL", [], |r| r.get(0))?;
        if !mode.eq_ignore_ascii_case("wal") {
            return Err(StoreError::Internal(format!(
                "journal_mode is {mode}, not wal"
            )));
        }
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        schema::migrate(&mut conn)?;

        let (tx, rx) = mpsc::channel::<Job>();
        std::thread::Builder::new()
            .name("autophys-store-writer".into())
            .spawn(move || {
                let mut conn = conn;
                while let Ok(job) = rx.recv() {
                    // A panicking job must not take the writer down with it;
                    // its caller sees the dropped reply as an error.
                    let _ = std::panic::catch_unwind(AssertUnwindSafe(|| job(&mut conn)));
                }
            })
            .map_err(|e| StoreError::Internal(format!("spawn writer: {e}")))?;
        let (bus, _) = broadcast::channel(opts.broadcast_capacity.max(16));
        Ok(Store {
            inner: Arc::new(Inner {
                path,
                opts,
                writer: tx,
                readers: Mutex::new(Vec::new()),
                bus,
            }),
        })
    }

    pub fn options(&self) -> &Options {
        &self.inner.opts
    }

    pub fn path(&self) -> &Path {
        &self.inner.path
    }

    /// Records as they commit, in `gseq` order. A receiver that lags gets
    /// `RecvError::Lagged` and should re-read from its cursor
    /// ([`Store::records_after`]); the SSE route does exactly that.
    pub fn subscribe(&self) -> broadcast::Receiver<Arc<Logged>> {
        self.inner.bus.subscribe()
    }

    pub(crate) async fn write<T: Send + 'static>(
        &self,
        f: impl FnOnce(&mut Connection) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let (tx, rx) = oneshot::channel();
        self.inner
            .writer
            .send(Box::new(move |conn| {
                let _ = tx.send(f(conn));
            }))
            .map_err(|_| StoreError::Internal("store writer stopped".into()))?;
        rx.await
            .map_err(|_| StoreError::Internal("store write failed".into()))?
    }

    fn send_and_forget(&self, f: impl FnOnce(&mut Connection) + Send + 'static) {
        let _ = self.inner.writer.send(Box::new(f));
    }

    async fn read<T: Send + 'static>(
        &self,
        f: impl FnOnce(&Connection) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let inner = self.inner.clone();
        tokio::task::spawn_blocking(move || {
            let conn = inner.take_reader()?;
            let out = f(&conn);
            inner.put_reader(conn);
            out
        })
        .await
        .map_err(|e| StoreError::Internal(format!("read task: {e}")))?
    }

    // --- reference data -----------------------------------------------------

    /// Idempotent by name: `(project, true)` when it was created.
    pub async fn ensure_project(&self, name: &str) -> Result<(Project, bool)> {
        if name.trim().is_empty() || name.len() > 200 {
            return Err(StoreError::invalid(
                "name",
                "required string of 1 to 200 characters",
            ));
        }
        let name = name.to_string();
        self.write(move |conn| {
            let tx = conn.transaction()?;
            let existing: Option<String> = tx
                .query_row("SELECT id FROM projects WHERE name = ?1", [&name], |r| {
                    r.get(0)
                })
                .optional()?;
            if let Some(id) = existing {
                return Ok((Project { id, name }, false));
            }
            let id = format!("prj_{}", keys::random_hex(8)?);
            tx.execute(
                "INSERT INTO projects (id, name, created) VALUES (?1, ?2, ?3)",
                rusqlite::params![id, name, ts_of(now())],
            )?;
            tx.commit()?;
            Ok((Project { id, name }, true))
        })
        .await
    }

    pub async fn projects(&self) -> Result<Vec<Project>> {
        self.read(list_projects).await
    }

    /// Store `body` as config `version` of `project`. The version must be
    /// `sha256:<hex of body>` (422 `hash_mismatch`) and the body JSON.
    /// Returns whether it was new; re-putting identical bytes is a no-op.
    pub async fn put_config_version(
        &self,
        project: &str,
        version: &str,
        body: &[u8],
    ) -> Result<bool> {
        let want = format!("sha256:{}", canonical::sha256_hex([body]));
        if want != version {
            return Err(StoreError::HashMismatch);
        }
        let text = std::str::from_utf8(body)
            .ok()
            .filter(|t| serde_json::from_str::<Value>(t).is_ok())
            .ok_or_else(|| StoreError::invalid("$", "the config body must be JSON"))?
            .to_string();
        let (project, version) = (project.to_string(), version.to_string());
        self.write(move |conn| {
            let tx = conn.transaction()?;
            let known: bool = tx
                .query_row("SELECT 1 FROM projects WHERE id = ?1", [&project], |_| {
                    Ok(())
                })
                .optional()?
                .is_some();
            if !known {
                return Err(StoreError::NotFound("project"));
            }
            let n = tx.execute(
                "INSERT OR IGNORE INTO config_versions (project, version, body, created)
                 VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![project, version, text, ts_of(now())],
            )?;
            tx.commit()?;
            Ok(n == 1)
        })
        .await
    }

    /// A project's config versions; `NotFound` for an unknown project.
    pub async fn config_versions(&self, project: &str) -> Result<Vec<ConfigVersion>> {
        let project = project.to_string();
        self.read(move |c| {
            let known: bool = c
                .query_row("SELECT 1 FROM projects WHERE id = ?1", [&project], |_| {
                    Ok(())
                })
                .optional()?
                .is_some();
            if !known {
                return Err(StoreError::NotFound("project"));
            }
            Ok(list_configs(c, Some(&project))?
                .into_iter()
                .map(|p| ConfigVersion {
                    version: p.version,
                    config: p.config,
                })
                .collect())
        })
        .await
    }

    // --- reads --------------------------------------------------------------

    pub async fn investigations(&self) -> Result<Vec<Investigation>> {
        self.read(projections::investigations).await
    }

    /// An investigation's records in seq order (`NotFound` if unknown).
    pub async fn records(&self, inv: &str, kind: Option<Kind>) -> Result<Vec<Record>> {
        let inv = inv.to_string();
        self.read(move |c| {
            if !projections::investigation_exists(c, &inv)? {
                return Err(StoreError::NotFound("investigation"));
            }
            records::of_investigation(c, &inv, kind.map(Kind::as_str))
        })
        .await
    }

    pub async fn proposal(&self, inv: &str, pid: &str) -> Result<Proposal> {
        let (inv, pid) = (inv.to_string(), pid.to_string());
        self.read(move |c| {
            if !projections::investigation_exists(c, &inv)? {
                return Err(StoreError::NotFound("investigation"));
            }
            projections::proposals(c, Some((&inv, &pid)))?
                .into_iter()
                .next()
                .ok_or(StoreError::NotFound("proposal"))
        })
        .await
    }

    /// Up to `limit` records after global cursor `after`, optionally of one
    /// investigation only.
    pub async fn records_after(
        &self,
        after: i64,
        limit: i64,
        investigation: Option<&str>,
    ) -> Result<Vec<Logged>> {
        let inv = investigation.map(str::to_owned);
        self.read(move |c| records::after(c, after, limit, inv.as_deref()))
            .await
    }

    /// One consistent snapshot (a single read transaction).
    pub async fn workspace(&self) -> Result<Workspace> {
        self.read(|c| {
            let tx = c.unchecked_transaction()?;
            let cursor = records::cursor(&tx)?;
            let ws = Workspace {
                cursor,
                projects: list_projects(&tx)?,
                config_versions: list_configs(&tx, None)?,
                investigations: projections::investigations(&tx)?,
                proposals: projections::proposals(&tx, None)?,
                records: records::after(&tx, 0, i64::MAX, None)?
                    .into_iter()
                    .filter(|l| l.gseq <= cursor)
                    .map(|l| l.record)
                    .collect(),
            };
            tx.finish()?;
            Ok(ws)
        })
        .await
    }

    // --- keys and pairing (the CLI calls these) -----------------------------

    /// Start a device-code pairing for `device` (`POST /pair/start`).
    pub async fn pair_start(&self, device: &str, client: &str) -> Result<PairStart> {
        if device.chars().count() > 100 || client.chars().count() > 200 {
            return Err(StoreError::invalid("device_name", "at most 100 characters"));
        }
        let device = if device.trim().is_empty() {
            "unnamed device"
        } else {
            device
        }
        .to_string();
        let client = client.to_string();
        let opts = self.inner.opts.clone();
        self.write(move |conn| {
            keys::pair_start(
                conn,
                keys::PairParams {
                    device: &device,
                    client: &client,
                    ttl_secs: opts.pairing_ttl.as_secs(),
                    interval_secs: opts.poll_interval.as_secs(),
                    verification_url: &opts.verification_url,
                },
                now(),
            )
        })
        .await
    }

    /// Poll a pairing (`POST /pair/poll`). `Err(Pairing(code))` until
    /// approved; then the key, exactly once.
    pub async fn pair_poll(&self, device_code: &str) -> Result<IssuedKey> {
        let device_code = device_code.to_string();
        let opts = self.inner.opts.clone();
        self.write(move |conn| {
            keys::pair_poll(
                conn,
                &device_code,
                keys::PollParams {
                    interval_secs: opts.poll_interval.as_secs(),
                    account: &opts.account,
                    workspace: &opts.workspace,
                },
                now(),
            )
        })
        .await
    }

    /// `autophys pair approve WXYZ-1234`.
    pub async fn pair_approve(&self, user_code: &str) -> Result<Pairing> {
        let code = user_code.to_string();
        self.write(move |conn| keys::pair_decide(conn, &code, true, now()))
            .await
    }

    /// Decline a pairing; the device's next poll gets `access_denied`.
    pub async fn pair_deny(&self, user_code: &str) -> Result<Pairing> {
        let code = user_code.to_string();
        self.write(move |conn| keys::pair_decide(conn, &code, false, now()))
            .await
    }

    /// Pairings waiting for approval (`GET /pairings`, `autophys pair list`).
    pub async fn pairings_pending(&self) -> Result<Vec<Pairing>> {
        self.read(|c| keys::pending(c, now())).await
    }

    pub async fn keys_list(&self) -> Result<Vec<KeyInfo>> {
        self.read(keys::list).await
    }

    /// Revoke key `id`: `Ok(true)` if it was live, `Ok(false)` if already revoked.
    pub async fn keys_revoke(&self, id: &str) -> Result<bool> {
        let id = id.to_string();
        self.write(move |conn| keys::revoke(conn, &id, now())).await
    }

    /// The live key matching a bearer token. Refreshes `last_used` at most
    /// once a minute, off the request path.
    pub async fn authenticate(&self, token: &str) -> Result<Option<KeyInfo>> {
        let token = token.to_string();
        let found = self.read(move |c| keys::lookup(c, &token)).await?;
        if let Some(key) = &found {
            let stale = key
                .last_used
                .as_deref()
                .and_then(|t| DateTime::parse_from_rfc3339(t).ok())
                .is_none_or(|t| now().signed_duration_since(t) > chrono::Duration::seconds(60));
            if stale {
                let id = key.id.clone();
                self.send_and_forget(move |conn| {
                    let _ = keys::touch(conn, &id, now());
                });
            }
        }
        Ok(found)
    }

    // --- maintenance --------------------------------------------------------

    /// Verify every investigation's hash chain and compare the projections
    /// with a fresh replay of the log; with `rebuild`, replace them by it.
    /// The log itself is never changed.
    pub async fn db_check(&self, rebuild: bool) -> Result<CheckReport> {
        self.write(move |conn| {
            let tx = conn.transaction()?;
            let (records, investigations, chain_errors) = verify_chains(&tx)?;
            let before = projections::dump(&tx)?;
            projections::rebuild(&tx)?;
            let after = projections::dump(&tx)?;
            let projections_match = before == after;
            if rebuild {
                tx.commit()?;
            }
            Ok(CheckReport {
                records,
                investigations,
                chain_errors,
                projections_match,
                rebuilt: rebuild,
            })
        })
        .await
    }
}

impl Inner {
    fn take_reader(&self) -> Result<Connection> {
        if let Some(c) = self.readers.lock().map_err(|_| poisoned())?.pop() {
            return Ok(c);
        }
        let conn = Connection::open_with_flags(
            &self.path,
            OpenFlags::SQLITE_OPEN_READ_ONLY
                | OpenFlags::SQLITE_OPEN_NO_MUTEX
                | OpenFlags::SQLITE_OPEN_URI,
        )?;
        configure_conn(&conn)?;
        Ok(conn)
    }

    fn put_reader(&self, conn: Connection) {
        if let Ok(mut pool) = self.readers.lock()
            && pool.len() < self.opts.readers.max(1)
        {
            pool.push(conn);
        }
    }
}

fn poisoned() -> StoreError {
    StoreError::Internal("reader pool poisoned".into())
}

fn verify_chains(conn: &Connection) -> Result<(usize, usize, Vec<ChainError>)> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {} FROM records ORDER BY investigation, seq",
        records::COLUMNS
    ))?;
    let mut rows = stmt.query([])?;
    let (mut count, mut invs, mut errors) = (0usize, 0usize, Vec::new());
    let mut current: Option<String> = None;
    let (mut expect_seq, mut prev) = (0i64, GENESIS.to_string());
    while let Some(row) = rows.next()? {
        let (l, text) = records::from_row(row)?;
        let r = l.record;
        count += 1;
        if current.as_deref() != Some(&r.investigation) {
            current = Some(r.investigation.clone());
            invs += 1;
            expect_seq = 0;
            prev = GENESIS.to_string();
        }
        let mut problem = |p: String| {
            errors.push(ChainError {
                investigation: r.investigation.clone(),
                seq: r.seq,
                id: r.id.clone(),
                problem: p,
            })
        };
        if r.seq != expect_seq {
            problem(format!("seq {} where {} was expected", r.seq, expect_seq));
        }
        if r.prev_hash != prev {
            problem("prev_hash does not match the previous record's hash".into());
        }
        if canonical(&r.payload) != text {
            problem("stored payload is not canonical JSON".into());
        }
        if chain_hash(&r.prev_hash, &r.id, &r.kind, &r.payload) != r.hash {
            problem("hash does not match sha256(prev_hash || canonical{id, kind, payload})".into());
        }
        expect_seq = r.seq + 1;
        prev = r.hash;
    }
    Ok((count, invs, errors))
}

fn list_projects(conn: &Connection) -> Result<Vec<Project>> {
    let mut stmt = conn.prepare_cached("SELECT id, name FROM projects ORDER BY created, id")?;
    let rows = stmt.query_map([], |r| {
        Ok(Project {
            id: r.get(0)?,
            name: r.get(1)?,
        })
    })?;
    rows.map(|r| r.map_err(StoreError::from)).collect()
}

fn list_configs(conn: &Connection, project: Option<&str>) -> Result<Vec<ProjectConfig>> {
    let mut stmt = conn.prepare_cached(
        "SELECT project, version, body FROM config_versions
          WHERE (?1 IS NULL OR project = ?1) ORDER BY project, created, version",
    )?;
    let rows = stmt.query_map([project], |r| {
        let body: String = r.get(2)?;
        Ok(ProjectConfig {
            project_id: r.get(0)?,
            version: r.get(1)?,
            config: serde_json::from_str(&body).unwrap_or(Value::Null),
        })
    })?;
    rows.map(|r| r.map_err(StoreError::from)).collect()
}
