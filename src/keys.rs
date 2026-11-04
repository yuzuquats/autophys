//! API keys and the device-code pairing flow (RFC 8628 shaped, as the SDK's
//! `pair_start` / `pair_poll` expect), in the server's own database. Keys and
//! pairings are never in a workbook (workbook-format.md); this file sits next
//! to the app: tento-dirs data (`~/.local/share/tento/autophys/server.db`).
//!
//! Only sha256 hashes of keys and device codes are stored. A key exists in
//! plaintext exactly once: in the `pair_poll` response that hands it to the
//! device. Approval only marks the pairing; the key is minted by the first
//! poll after it, so nothing has to keep the plaintext in between. No type
//! that holds a secret prints it through `Debug`.

use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;

use crate::error::{ApiError, Result};
use autophys::sha256_hex;

/// What the CLI and `keys_list` show about a key; never the key.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct KeyInfo {
    pub id: String,
    pub device: String,
    pub created: String,
    pub last_used: Option<String>,
    pub revoked: Option<String>,
}

/// `POST /pair/start` response.
#[derive(Clone, PartialEq, Serialize)]
pub struct PairStart {
    pub device_code: String,
    pub user_code: String,
    pub verification_url: String,
    pub interval: u64,
    pub expires_in: u64,
}

impl fmt::Debug for PairStart {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PairStart")
            .field("device_code", &"<redacted>")
            .field("user_code", &self.user_code)
            .field("interval", &self.interval)
            .field("expires_in", &self.expires_in)
            .finish()
    }
}

/// `POST /pair/poll` success: the only place a key leaves the store.
#[derive(Clone, PartialEq, Serialize)]
pub struct IssuedKey {
    pub api_key: String,
    pub key_id: String,
    pub account: String,
    pub workspace: String,
}

impl fmt::Debug for IssuedKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("IssuedKey")
            .field("api_key", &"<redacted>")
            .field("key_id", &self.key_id)
            .finish()
    }
}

/// A pending pairing as the CLI and `GET /pairings` show it: never the
/// device code, never a key.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Pairing {
    pub user_code: String,
    pub device_name: String,
    pub client: String,
    pub expires: String,
}

/// Prefix of every API key, so a leaked key is recognisable in a scan.
pub const KEY_PREFIX: &str = "apk_";

pub(crate) fn now_text(now: DateTime<Utc>) -> String {
    now.to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub(crate) fn random_hex(bytes: usize) -> Result<String> {
    let mut buf = vec![0u8; bytes];
    getrandom::getrandom(&mut buf).map_err(|e| ApiError::Internal(format!("getrandom: {e}")))?;
    Ok(hex::encode(buf))
}

fn user_code() -> Result<String> {
    // No vowels (no words), no 0/O or 1/I confusion: BCDFGHJKLMNPQRSTVWXZ.
    const LETTERS: &[u8] = b"BCDFGHJKLMNPQRSTVWXZ";
    let mut buf = [0u8; 8];
    getrandom::getrandom(&mut buf).map_err(|e| ApiError::Internal(format!("getrandom: {e}")))?;
    let mut s = String::with_capacity(9);
    for (i, b) in buf.iter().enumerate() {
        if i == 4 {
            s.push('-');
        }
        if i < 4 {
            s.push(LETTERS[*b as usize % LETTERS.len()] as char);
        } else {
            s.push((b'0' + b % 10) as char);
        }
    }
    Ok(s)
}

/// Normalise what a person typed: `wxyz 1234` → `WXYZ-1234`.
pub fn normalize_user_code(code: &str) -> String {
    let compact: String = code.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
    let compact = compact.to_ascii_uppercase();
    if compact.len() == 8 {
        format!("{}-{}", &compact[..4], &compact[4..])
    } else {
        compact
    }
}

pub(crate) struct PairParams<'a> {
    pub device: &'a str,
    pub client: &'a str,
    pub ttl_secs: u64,
    pub interval_secs: u64,
    pub verification_url: &'a str,
}

pub(crate) fn pair_start(
    conn: &Connection,
    p: PairParams<'_>,
    now: DateTime<Utc>,
) -> Result<PairStart> {
    // Housekeeping: finished or expired pairings are dropped on the next start.
    conn.execute(
        include_str!("../sql/keys/prune_pairings.sql"),
        [now_text(now)],
    )?;
    let device_code = random_hex(32)?;
    let expires = now + chrono::Duration::seconds(p.ttl_secs as i64);
    for _ in 0..8 {
        let code = user_code()?;
        let inserted = conn.execute(
            include_str!("../sql/keys/start_pairing.sql"),
            params![
                sha256_hex([device_code.as_bytes()]),
                code,
                p.device,
                p.client,
                now_text(now),
                now_text(expires)
            ],
        );
        match inserted {
            Ok(_) => {
                return Ok(PairStart {
                    device_code,
                    user_code: code,
                    verification_url: p.verification_url.to_string(),
                    interval: p.interval_secs,
                    expires_in: p.ttl_secs,
                });
            }
            Err(rusqlite::Error::SqliteFailure(e, _))
                if e.code == rusqlite::ErrorCode::ConstraintViolation =>
            {
                continue; // a live pairing already holds this user code
            }
            Err(e) => return Err(e.into()),
        }
    }
    Err(ApiError::Internal(
        "could not allocate a free user code".into(),
    ))
}

pub(crate) struct PollParams<'a> {
    pub interval_secs: u64,
    pub account: &'a str,
    pub workspace: &'a str,
}

pub(crate) fn pair_poll(
    conn: &mut Connection,
    device_code: &str,
    p: PollParams<'_>,
    now: DateTime<Utc>,
) -> Result<IssuedKey> {
    let tx = conn.transaction()?;
    let sha = sha256_hex([device_code.as_bytes()]);
    let row: Option<(String, String, String, Option<i64>)> = tx
        .query_row(include_str!("../sql/keys/poll_pairing.sql"), [&sha], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })
        .optional()?;
    let Some((state, device, expires, last_poll)) = row else {
        return Err(ApiError::Pairing("expired_token"));
    };
    if expires < now_text(now) || state == "issued" {
        return Err(ApiError::Pairing("expired_token"));
    }
    let now_ms = now.timestamp_millis();
    match state.as_str() {
        "denied" => {
            tx.execute(include_str!("../sql/keys/expire_pairing.sql"), [&sha])?;
            tx.commit()?;
            Err(ApiError::Pairing("access_denied"))
        }
        "pending" => {
            tx.execute(
                include_str!("../sql/keys/touch_poll.sql"),
                params![sha, now_ms],
            )?;
            tx.commit()?;
            // RFC 8628 §3.5: polling faster than the interval earns slow_down.
            // Allow 20% jitter so a client that sleeps exactly `interval` passes.
            let min_gap = (p.interval_secs as i64) * 800;
            match last_poll {
                Some(prev) if now_ms - prev < min_gap => Err(ApiError::Pairing("slow_down")),
                _ => Err(ApiError::Pairing("authorization_pending")),
            }
        }
        "approved" => {
            let api_key = format!("{KEY_PREFIX}{}", random_hex(32)?);
            let key_id = format!("k_{}", random_hex(6)?);
            tx.execute(
                include_str!("../sql/keys/issue_key.sql"),
                params![
                    key_id,
                    device,
                    sha256_hex([api_key.as_bytes()]),
                    now_text(now)
                ],
            )?;
            tx.execute(
                include_str!("../sql/keys/finish_pairing.sql"),
                params![sha, key_id],
            )?;
            tx.commit()?;
            Ok(IssuedKey {
                api_key,
                key_id,
                account: p.account.to_string(),
                workspace: p.workspace.to_string(),
            })
        }
        other => Err(ApiError::Internal(format!(
            "pairing in unknown state {other}"
        ))),
    }
}

/// Approve (`approve = true`) or deny a pending, unexpired pairing.
pub(crate) fn pair_decide(
    conn: &Connection,
    user_code: &str,
    approve: bool,
    now: DateTime<Utc>,
) -> Result<Pairing> {
    let code = normalize_user_code(user_code);
    let row: Option<(String, String, String, String)> = conn
        .query_row(
            include_str!("../sql/keys/find_pairing.sql"),
            [&code, &now_text(now)],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?;
    let Some((sha, device, client, expires)) = row else {
        return Err(ApiError::not_found("pairing code"));
    };
    conn.execute(
        include_str!("../sql/keys/decide_pairing.sql"),
        [sha.as_str(), if approve { "approved" } else { "denied" }],
    )?;
    Ok(Pairing {
        user_code: code,
        device_name: device,
        client,
        expires,
    })
}

/// Pairings still waiting for a person, oldest first.
pub(crate) fn pending(conn: &Connection, now: DateTime<Utc>) -> Result<Vec<Pairing>> {
    let mut stmt = conn.prepare(include_str!("../sql/keys/pending_pairings.sql"))?;
    let rows = stmt.query_map([now_text(now)], |r| {
        Ok(Pairing {
            user_code: r.get(0)?,
            device_name: r.get(1)?,
            client: r.get(2)?,
            expires: r.get(3)?,
        })
    })?;
    rows.map(|r| r.map_err(ApiError::from)).collect()
}

pub(crate) fn list(conn: &Connection) -> Result<Vec<KeyInfo>> {
    let mut stmt = conn.prepare(include_str!("../sql/keys/list_keys.sql"))?;
    let rows = stmt.query_map([], |r| {
        Ok(KeyInfo {
            id: r.get(0)?,
            device: r.get(1)?,
            created: r.get(2)?,
            last_used: r.get(3)?,
            revoked: r.get(4)?,
        })
    })?;
    rows.map(|r| r.map_err(ApiError::from)).collect()
}

/// `Ok(true)` if the key was live and is now revoked, `Ok(false)` if it was
/// already revoked.
pub(crate) fn revoke(conn: &Connection, id: &str, now: DateTime<Utc>) -> Result<bool> {
    let revoked: Option<Option<String>> = conn
        .query_row(include_str!("../sql/keys/key_revocation.sql"), [id], |r| {
            r.get(0)
        })
        .optional()?;
    match revoked {
        None => Err(ApiError::not_found("key")),
        Some(Some(_)) => Ok(false),
        Some(None) => {
            conn.execute(
                include_str!("../sql/keys/revoke_key.sql"),
                [id, &now_text(now)],
            )?;
            Ok(true)
        }
    }
}

/// The live key whose hash matches `token`, with its `last_used`.
pub(crate) fn lookup(conn: &Connection, token: &str) -> Result<Option<KeyInfo>> {
    Ok(conn
        .query_row(
            include_str!("../sql/keys/lookup_key.sql"),
            [sha256_hex([token.as_bytes()])],
            |r| {
                Ok(KeyInfo {
                    id: r.get(0)?,
                    device: r.get(1)?,
                    created: r.get(2)?,
                    last_used: r.get(3)?,
                    revoked: r.get(4)?,
                })
            },
        )
        .optional()?)
}

pub(crate) fn touch(conn: &Connection, id: &str, now: DateTime<Utc>) -> Result<()> {
    conn.execute(
        include_str!("../sql/keys/touch_key.sql"),
        [id, &now_text(now)],
    )?;
    Ok(())
}

// --- the server database ------------------------------------------------------

/// Migrations of the server database, keyed by its schema version.
const MIGRATIONS: &[&str] = &[
    include_str!("../sql/keys/schema_v1.sql"),
    // v2: browser sign-in accounts and sessions (`crate::accounts`).
    include_str!("../sql/keys/schema_v2.sql"),
];

fn migrate(conn: &mut Connection) -> Result<()> {
    let current: i64 = conn.query_row(include_str!("../sql/keys/schema_version.sql"), [], |r| {
        r.get(0)
    })?;
    for (i, sql) in MIGRATIONS.iter().enumerate().skip(current.max(0) as usize) {
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        tx.pragma_update(None, "user_version", (i + 1) as i64)?;
        tx.commit()?;
    }
    Ok(())
}

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
    /// browser-session reads are allowed (`/workspace`, `/stream`, `GET /pairings`).
    pub browser_hosts: Vec<String>,
    /// Origins besides the daemon's own (`http://127.0.0.1:<port>`,
    /// `http://localhost:<port>`, `http://[::1]:<port>`) whose keyless
    /// *writes* are admitted (O-3): `serve --browser-origin` or
    /// `AUTOPHYS_BROWSER_ORIGINS`, for example a tento.localhost proxy origin
    /// such as `http://autophys.rwc-dev-01.tento.localhost`.
    pub browser_origins: Vec<String>,
    /// `serve --login`: browsers must sign in with an invited account
    /// (`crate::accounts`); being on this machine is no longer enough.
    pub login: bool,
    /// `serve --public-url`: the origin people reach the daemon at, such as
    /// `https://autophys.lona.so`. Pairing and invite links point there, and
    /// an https URL makes the sign-in cookie `Secure`.
    pub public_url: Option<String>,
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
            login: false,
            public_url: None,
        }
    }
}

/// The server database: keys and pairings. One connection behind a mutex;
/// the admin CLI opens the same file from another process.
pub struct KeyStore {
    path: PathBuf,
    opts: Options,
    conn: Mutex<Connection>,
}

impl std::fmt::Debug for KeyStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("KeyStore")
            .field("path", &self.path)
            .finish()
    }
}

impl KeyStore {
    /// Open (creating if needed) the server database with default options.
    pub fn open(path: impl AsRef<Path>) -> Result<KeyStore> {
        KeyStore::open_with(path, Options::default())
    }

    /// Open with explicit [`Options`]: WAL mode, migrations.
    pub fn open_with(path: impl AsRef<Path>, opts: Options) -> Result<KeyStore> {
        let path = path.as_ref().to_path_buf();
        if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
            std::fs::create_dir_all(dir)
                .map_err(|e| ApiError::Internal(format!("create {}: {e}", dir.display())))?;
        }
        let mut conn = Connection::open(&path)?;
        conn.busy_timeout(Duration::from_secs(5))?;
        let mode: String =
            conn.query_row(include_str!("../sql/keys/journal_mode.sql"), [], |r| {
                r.get(0)
            })?;
        if !mode.eq_ignore_ascii_case("wal") {
            return Err(ApiError::Internal(format!(
                "journal_mode is {mode}, not wal"
            )));
        }
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        migrate(&mut conn)?;
        Ok(KeyStore {
            path,
            opts,
            conn: Mutex::new(conn),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn options(&self) -> &Options {
        &self.opts
    }

    fn conn(&self) -> Result<MutexGuard<'_, Connection>> {
        self.conn
            .lock()
            .map_err(|_| ApiError::Internal("server database connection poisoned".into()))
    }

    /// Start a device-code pairing for `device` (`POST /pair/start`).
    pub fn pair_start(&self, device: &str, client: &str) -> Result<PairStart> {
        if device.chars().count() > 100 || client.chars().count() > 200 {
            return Err(ApiError::invalid("device_name", "at most 100 characters"));
        }
        let device = if device.trim().is_empty() {
            "unnamed device"
        } else {
            device
        };
        pair_start(
            &*self.conn()?,
            PairParams {
                device,
                client,
                ttl_secs: self.opts.pairing_ttl.as_secs(),
                interval_secs: self.opts.poll_interval.as_secs(),
                verification_url: &self.opts.verification_url,
            },
            Utc::now(),
        )
    }

    /// Poll a pairing (`POST /pair/poll`). `Err(Pairing(code))` until
    /// approved; then the key, exactly once.
    pub fn pair_poll(&self, device_code: &str) -> Result<IssuedKey> {
        pair_poll(
            &mut *self.conn()?,
            device_code,
            PollParams {
                interval_secs: self.opts.poll_interval.as_secs(),
                account: &self.opts.account,
                workspace: &self.opts.workspace,
            },
            Utc::now(),
        )
    }

    /// `autophys pair approve WXYZ-1234`.
    pub fn pair_approve(&self, user_code: &str) -> Result<Pairing> {
        pair_decide(&*self.conn()?, user_code, true, Utc::now())
    }

    /// Decline a pairing; the device's next poll gets `access_denied`.
    pub fn pair_deny(&self, user_code: &str) -> Result<Pairing> {
        pair_decide(&*self.conn()?, user_code, false, Utc::now())
    }

    /// Pairings waiting for approval (`GET /pairings`, `autophys pair list`).
    pub fn pairings_pending(&self) -> Result<Vec<Pairing>> {
        pending(&*self.conn()?, Utc::now())
    }

    pub fn keys_list(&self) -> Result<Vec<KeyInfo>> {
        list(&*self.conn()?)
    }

    /// Revoke key `id`: `Ok(true)` if it was live, `Ok(false)` if already revoked.
    pub fn keys_revoke(&self, id: &str) -> Result<bool> {
        revoke(&*self.conn()?, id, Utc::now())
    }

    /// The live key matching a bearer token. Refreshes `last_used` at most
    /// once a minute.
    pub fn authenticate(&self, token: &str) -> Result<Option<KeyInfo>> {
        let conn = self.conn()?;
        let found = lookup(&conn, token)?;
        if let Some(key) = &found {
            let stale = key
                .last_used
                .as_deref()
                .and_then(|t| DateTime::parse_from_rfc3339(t).ok())
                .is_none_or(|t| {
                    Utc::now().signed_duration_since(t) > chrono::Duration::seconds(60)
                });
            if stale {
                let _ = touch(&conn, &key.id, Utc::now());
            }
        }
        Ok(found)
    }

    // --- browser accounts (`crate::accounts`) ---------------------------------

    /// `autophys users add EMAIL`: create or re-invite; the token is the link.
    pub fn users_invite(&self, email: &str) -> Result<crate::accounts::Invite> {
        crate::accounts::invite(&*self.conn()?, email, Utc::now())
    }

    /// Who an unexpired invite token was issued to.
    pub fn users_invitee(&self, token: &str) -> Result<Option<crate::accounts::User>> {
        crate::accounts::invitee(&*self.conn()?, token, Utc::now())
    }

    /// Accept an invite with the chosen password.
    pub fn users_accept(&self, token: &str, password: &str) -> Result<crate::accounts::User> {
        crate::accounts::accept(&mut *self.conn()?, token, password, Utc::now())
    }

    /// The active account with this email and password.
    pub fn users_check(
        &self,
        email: &str,
        password: &str,
    ) -> Result<Option<crate::accounts::User>> {
        crate::accounts::check_password(&*self.conn()?, email, password)
    }

    pub fn users_list(&self) -> Result<Vec<crate::accounts::User>> {
        crate::accounts::list(&*self.conn()?)
    }

    /// Delete an account and end its sessions.
    pub fn users_remove(&self, email: &str) -> Result<crate::accounts::User> {
        crate::accounts::remove(&mut *self.conn()?, email)
    }

    /// Start a sign-in session; the token goes in the cookie.
    pub fn session_start(&self, user: &crate::accounts::User) -> Result<String> {
        crate::accounts::session_start(&*self.conn()?, user, Utc::now())
    }

    /// The signed-in account behind a session cookie.
    pub fn session_user(&self, token: &str) -> Result<Option<crate::accounts::User>> {
        crate::accounts::session_user(&*self.conn()?, token, Utc::now())
    }

    pub fn session_end(&self, token: &str) -> Result<()> {
        crate::accounts::session_end(&*self.conn()?, token)
    }
}
