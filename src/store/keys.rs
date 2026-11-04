//! API keys and the device-code pairing flow (RFC 8628 shaped, as the SDK's
//! `pair_start` / `pair_poll` expect).
//!
//! Only sha256 hashes of keys and device codes are stored. A key exists in
//! plaintext exactly once: in the `pair_poll` response that hands it to the
//! device. Approval only marks the pairing; the key is minted by the first
//! poll after it, so nothing has to keep the plaintext in between. No type
//! that holds a secret prints it through `Debug`.

use std::fmt;

use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;

use crate::store::canonical::sha256_hex;
use crate::store::error::{Result, StoreError};

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
    getrandom::getrandom(&mut buf).map_err(|e| StoreError::Internal(format!("getrandom: {e}")))?;
    Ok(hex::encode(buf))
}

fn user_code() -> Result<String> {
    // No vowels (no words), no 0/O or 1/I confusion: BCDFGHJKLMNPQRSTVWXZ.
    const LETTERS: &[u8] = b"BCDFGHJKLMNPQRSTVWXZ";
    let mut buf = [0u8; 8];
    getrandom::getrandom(&mut buf).map_err(|e| StoreError::Internal(format!("getrandom: {e}")))?;
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
        "DELETE FROM pairings WHERE expires < ?1 OR state IN ('denied', 'issued')",
        [now_text(now)],
    )?;
    let device_code = random_hex(32)?;
    let expires = now + chrono::Duration::seconds(p.ttl_secs as i64);
    for _ in 0..8 {
        let code = user_code()?;
        let inserted = conn.execute(
            "INSERT INTO pairings
               (device_code_sha256, user_code, device, client, state, created, expires)
             VALUES (?1, ?2, ?3, ?4, 'pending', ?5, ?6)",
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
    Err(StoreError::Internal(
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
        .query_row(
            "SELECT state, device, expires, last_poll_ms FROM pairings WHERE device_code_sha256 = ?1",
            [&sha],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?;
    let Some((state, device, expires, last_poll)) = row else {
        return Err(StoreError::Pairing("expired_token"));
    };
    if expires < now_text(now) || state == "issued" {
        return Err(StoreError::Pairing("expired_token"));
    }
    let now_ms = now.timestamp_millis();
    match state.as_str() {
        "denied" => {
            tx.execute("DELETE FROM pairings WHERE device_code_sha256 = ?1", [&sha])?;
            tx.commit()?;
            Err(StoreError::Pairing("access_denied"))
        }
        "pending" => {
            tx.execute(
                "UPDATE pairings SET last_poll_ms = ?2 WHERE device_code_sha256 = ?1",
                params![sha, now_ms],
            )?;
            tx.commit()?;
            // RFC 8628 §3.5: polling faster than the interval earns slow_down.
            // Allow 20% jitter so a client that sleeps exactly `interval` passes.
            let min_gap = (p.interval_secs as i64) * 800;
            match last_poll {
                Some(prev) if now_ms - prev < min_gap => Err(StoreError::Pairing("slow_down")),
                _ => Err(StoreError::Pairing("authorization_pending")),
            }
        }
        "approved" => {
            let api_key = format!("{KEY_PREFIX}{}", random_hex(32)?);
            let key_id = format!("k_{}", random_hex(6)?);
            tx.execute(
                "INSERT INTO keys (id, device, sha256, created) VALUES (?1, ?2, ?3, ?4)",
                params![
                    key_id,
                    device,
                    sha256_hex([api_key.as_bytes()]),
                    now_text(now)
                ],
            )?;
            tx.execute(
                "UPDATE pairings SET state = 'issued', key_id = ?2 WHERE device_code_sha256 = ?1",
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
        other => Err(StoreError::Internal(format!(
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
            "SELECT device_code_sha256, device, client, expires FROM pairings
              WHERE user_code = ?1 AND state = 'pending' AND expires >= ?2",
            [&code, &now_text(now)],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?;
    let Some((sha, device, client, expires)) = row else {
        return Err(StoreError::NotFound("pairing code"));
    };
    conn.execute(
        "UPDATE pairings SET state = ?2 WHERE device_code_sha256 = ?1",
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
    let mut stmt = conn.prepare(
        "SELECT user_code, device, client, expires FROM pairings
          WHERE state = 'pending' AND expires >= ?1 ORDER BY created, user_code",
    )?;
    let rows = stmt.query_map([now_text(now)], |r| {
        Ok(Pairing {
            user_code: r.get(0)?,
            device_name: r.get(1)?,
            client: r.get(2)?,
            expires: r.get(3)?,
        })
    })?;
    rows.map(|r| r.map_err(StoreError::from)).collect()
}

pub(crate) fn list(conn: &Connection) -> Result<Vec<KeyInfo>> {
    let mut stmt = conn
        .prepare("SELECT id, device, created, last_used, revoked FROM keys ORDER BY created, id")?;
    let rows = stmt.query_map([], |r| {
        Ok(KeyInfo {
            id: r.get(0)?,
            device: r.get(1)?,
            created: r.get(2)?,
            last_used: r.get(3)?,
            revoked: r.get(4)?,
        })
    })?;
    rows.map(|r| r.map_err(StoreError::from)).collect()
}

/// `Ok(true)` if the key was live and is now revoked, `Ok(false)` if it was
/// already revoked.
pub(crate) fn revoke(conn: &Connection, id: &str, now: DateTime<Utc>) -> Result<bool> {
    let revoked: Option<Option<String>> = conn
        .query_row("SELECT revoked FROM keys WHERE id = ?1", [id], |r| r.get(0))
        .optional()?;
    match revoked {
        None => Err(StoreError::NotFound("key")),
        Some(Some(_)) => Ok(false),
        Some(None) => {
            conn.execute(
                "UPDATE keys SET revoked = ?2 WHERE id = ?1",
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
            "SELECT id, device, created, last_used, revoked FROM keys
              WHERE sha256 = ?1 AND revoked IS NULL",
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
        "UPDATE keys SET last_used = ?2 WHERE id = ?1",
        [id, &now_text(now)],
    )?;
    Ok(())
}
