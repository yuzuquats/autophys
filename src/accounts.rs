//! People who sign in to the browser app (`serve --login`): invite-only
//! accounts with an email and a password, and their sign-in sessions. They
//! live in the server database next to keys and pairings (schema v2).
//!
//! An operator invites someone with `autophys users add EMAIL`, which prints a
//! one-time link; the invitee opens it and chooses a password. Re-inviting an
//! existing account issues a fresh link, which doubles as a password reset.
//!
//! Only hashes are stored: argon2id for passwords, sha256 for invite and
//! session tokens. A token exists in plaintext exactly once, in the response
//! (or CLI output) that hands it out. No type that holds a secret prints it.

use std::fmt;

use argon2::Argon2;
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use chrono::{DateTime, Utc};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;

use crate::error::{ApiError, Result};
use crate::keys::{now_text, random_hex};
use autophys::sha256_hex;

/// How long an invite link stays valid.
pub const INVITE_TTL: chrono::Duration = chrono::Duration::days(7);
/// How long a sign-in lasts.
pub const SESSION_TTL: chrono::Duration = chrono::Duration::days(30);
/// The shortest password an invitee may choose.
pub const MIN_PASSWORD: usize = 10;

/// An account as the CLI, `/api/auth/me` and the badge show it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct User {
    pub id: String,
    pub email: String,
    pub created: String,
    /// False until the invite has been accepted and a password chosen.
    pub active: bool,
    /// May read but not change anything (`autophys users set EMAIL --read-only`).
    pub read_only: bool,
    /// The demo account: no password; anyone may continue as it.
    pub demo: bool,
}

/// `users add`: the account and its one-time invite token.
#[derive(Clone, PartialEq)]
pub struct Invite {
    pub user: User,
    pub token: String,
}

impl fmt::Debug for Invite {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Invite")
            .field("user", &self.user)
            .field("token", &"<redacted>")
            .finish()
    }
}

/// Trim and lowercase an email; refuse anything that is not `local@domain`.
pub fn normalize_email(email: &str) -> Result<String> {
    let email = email.trim().to_ascii_lowercase();
    let valid = email.len() <= 254
        && email.split_once('@').is_some_and(|(local, domain)| {
            !local.is_empty() && domain.contains('.') && !domain.starts_with('.')
        })
        && !email
            .chars()
            .any(|c| c.is_whitespace() || c.is_control() || "<>\"'".contains(c));
    if valid {
        Ok(email)
    } else {
        Err(ApiError::invalid("email", "not an email address"))
    }
}

fn hash_password(password: &str) -> Result<String> {
    let mut salt = [0u8; 16];
    getrandom::getrandom(&mut salt).map_err(|e| ApiError::Internal(format!("getrandom: {e}")))?;
    let salt = SaltString::encode_b64(&salt).map_err(|e| ApiError::Internal(e.to_string()))?;
    Ok(Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map_err(|e| ApiError::Internal(format!("hash password: {e}")))?
        .to_string())
}

fn verify_password(password: &str, phc: &str) -> bool {
    PasswordHash::new(phc).is_ok_and(|h| {
        Argon2::default()
            .verify_password(password.as_bytes(), &h)
            .is_ok()
    })
}

/// Verify against a throwaway hash, so a sign-in for an unknown or
/// uninvited email costs the same as one with a wrong password.
fn decoy_verify(password: &str) {
    static DECOY: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    let phc = DECOY
        .get_or_init(|| hash_password(&random_hex(16).unwrap_or_default()).unwrap_or_default());
    verify_password(password, phc);
}

fn user_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<User> {
    Ok(User {
        id: r.get(0)?,
        email: r.get(1)?,
        created: r.get(2)?,
        active: r.get::<_, Option<String>>(3)?.is_some() || r.get::<_, i64>(5)? != 0,
        read_only: r.get::<_, i64>(4)? != 0 || r.get::<_, i64>(5)? != 0,
        demo: r.get::<_, i64>(5)? != 0,
    })
}

const USER_COLS: &str = "id, email, created, password, read_only, demo";

/// Create the account for `email` if it is new, and issue a fresh invite
/// (replacing any earlier one). An existing password keeps working until the
/// invite is accepted.
pub(crate) fn invite(conn: &Connection, email: &str, now: DateTime<Utc>) -> Result<Invite> {
    let email = normalize_email(email)?;
    let token = random_hex(32)?;
    let expires = now_text(now + INVITE_TTL);
    let id = format!("u_{}", random_hex(6)?);
    conn.execute(
        "INSERT INTO users (id, email, created, invite_sha256, invite_expires)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(email) DO UPDATE SET
           invite_sha256 = excluded.invite_sha256,
           invite_expires = excluded.invite_expires",
        params![
            id,
            email,
            now_text(now),
            sha256_hex([token.as_bytes()]),
            expires
        ],
    )?;
    let user = conn.query_row(
        &format!("SELECT {USER_COLS} FROM users WHERE email = ?1"),
        [&email],
        user_row,
    )?;
    Ok(Invite { user, token })
}

/// Who an unexpired invite token belongs to (the invite page shows it).
pub(crate) fn invitee(conn: &Connection, token: &str, now: DateTime<Utc>) -> Result<Option<User>> {
    Ok(conn
        .query_row(
            &format!(
                "SELECT {USER_COLS} FROM users WHERE invite_sha256 = ?1 AND invite_expires > ?2"
            ),
            params![sha256_hex([token.as_bytes()]), now_text(now)],
            user_row,
        )
        .optional()?)
}

/// Check an invite acceptance without hashing: the password rules and an
/// unexpired token. The caller hashes ([`password_hash`]) outside the
/// database lock, then calls [`accept_commit`].
pub(crate) fn accept_check(
    conn: &Connection,
    token: &str,
    password: &str,
    now: DateTime<Utc>,
) -> Result<User> {
    if password.chars().count() < MIN_PASSWORD {
        return Err(ApiError::invalid(
            "password",
            format!("at least {MIN_PASSWORD} characters"),
        ));
    }
    if password.len() > 1024 {
        return Err(ApiError::invalid("password", "at most 1024 bytes"));
    }
    invitee(conn, token, now)?
        .ok_or_else(|| ApiError::not_found("invite (it may have expired or been used)"))
}

/// The argon2 hash of a password (slow by design: hold no lock).
pub(crate) fn password_hash(password: &str) -> Result<String> {
    hash_password(password)
}

/// Set the hashed password, spend the token, and end every earlier session
/// of the account (a reset signs out other browsers). The token is checked
/// again inside the transaction, so one spent meanwhile is refused.
pub(crate) fn accept_commit(
    conn: &mut Connection,
    token: &str,
    phc: &str,
    now: DateTime<Utc>,
) -> Result<User> {
    let tx = conn.transaction()?;
    let Some(user) = invitee(&tx, token, now)? else {
        return Err(ApiError::not_found(
            "invite (it may have expired or been used)",
        ));
    };
    tx.execute(
        "UPDATE users SET password = ?2, invite_sha256 = NULL, invite_expires = NULL
         WHERE id = ?1",
        params![user.id, phc],
    )?;
    tx.execute("DELETE FROM sessions WHERE user_id = ?1", [&user.id])?;
    tx.commit()?;
    Ok(User {
        active: true,
        ..user
    })
}

/// Accept an invite in one call ([`accept_check`], hash, [`accept_commit`]).
pub(crate) fn accept(
    conn: &mut Connection,
    token: &str,
    password: &str,
    now: DateTime<Utc>,
) -> Result<User> {
    accept_check(conn, token, password, now)?;
    let phc = hash_password(password)?;
    accept_commit(conn, token, &phc, now)
}

/// An account and its password hash, looked up by email (no hashing).
pub(crate) type PasswordRow = Option<(User, Option<String>)>;

/// Look up the account a sign-in names. Cheap: verify with [`verify_row`]
/// after releasing the database lock.
pub(crate) fn password_row(conn: &Connection, email: &str) -> Result<PasswordRow> {
    let Ok(email) = normalize_email(email) else {
        return Ok(None);
    };
    Ok(conn
        .query_row(
            &format!("SELECT {USER_COLS} FROM users WHERE email = ?1"),
            [&email],
            |r| Ok((user_row(r)?, r.get(3)?)),
        )
        .optional()?)
}

/// The account if the password matches. An unknown or uninvited email costs
/// the same argon2 work as a wrong password.
pub(crate) fn verify_row(row: PasswordRow, password: &str) -> Option<User> {
    match row {
        Some((user, Some(phc))) if verify_password(password, &phc) => Some(user),
        Some((_, Some(_))) => None,
        _ => {
            decoy_verify(password);
            None
        }
    }
}

/// The active account whose email and password match, else `None`.
pub(crate) fn check_password(
    conn: &Connection,
    email: &str,
    password: &str,
) -> Result<Option<User>> {
    Ok(verify_row(password_row(conn, email)?, password))
}

/// Make EMAIL the demo account, or stop it being one. A demo account has no
/// password and no invite; there is at most one (setting it moves the flag).
/// Turning it off leaves the account without a password until re-invited.
pub(crate) fn set_demo(conn: &mut Connection, email: &str, demo: bool) -> Result<User> {
    let email = normalize_email(email)?;
    let tx = conn.transaction()?;
    // Reconfiguring public access ends both the old and new demo sessions.
    tx.execute(
        "DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE demo = 1 OR email = ?1)",
        [&email],
    )?;
    tx.execute("UPDATE keys SET revoked = ?1 WHERE id IN (SELECT key_id FROM key_access WHERE owner_id IN (SELECT id FROM users WHERE demo = 1 OR email = ?2))", params![now_text(Utc::now()), email])?;
    if demo {
        tx.execute(
            "INSERT INTO users (id, email, created) VALUES (?1, ?2, ?3) ON CONFLICT(email) DO NOTHING",
            params![format!("u_{}", random_hex(6)?), email, now_text(Utc::now())],
        )?;
        tx.execute(
            "UPDATE users SET demo = 0 WHERE demo = 1 AND email <> ?1",
            [&email],
        )?;
        tx.execute(
            "UPDATE users SET demo = 1, read_only = 1, password = NULL, invite_sha256 = NULL, invite_expires = NULL
             WHERE email = ?1",
            [&email],
        )?;
    } else {
        let n = tx.execute("UPDATE users SET demo = 0 WHERE email = ?1", [&email])?;
        if n == 0 {
            return Err(ApiError::not_found("account"));
        }
        // Whoever was signed in as the demo account is signed out with it.
        tx.execute(
            "DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE email = ?1)",
            [&email],
        )?;
    }
    let user = tx.query_row(
        &format!("SELECT {USER_COLS} FROM users WHERE email = ?1"),
        [&email],
        user_row,
    )?;
    tx.commit()?;
    Ok(user)
}

/// The demo account, if one is set.
pub(crate) fn demo_user(conn: &Connection) -> Result<Option<User>> {
    Ok(conn
        .query_row(
            &format!("SELECT {USER_COLS} FROM users WHERE demo = 1 LIMIT 1"),
            [],
            user_row,
        )
        .optional()?)
}

/// Mark an account read-only, or read-write again.
pub(crate) fn set_read_only(conn: &Connection, email: &str, read_only: bool) -> Result<User> {
    let email = normalize_email(email)?;
    if !read_only
        && conn
            .query_row("SELECT demo FROM users WHERE email = ?1", [&email], |r| {
                r.get::<_, i64>(0)
            })
            .optional()?
            .unwrap_or(0)
            != 0
    {
        return Err(ApiError::bad_request(
            "Disable demo sign-in before granting write access.",
        ));
    }
    let n = conn.execute(
        "UPDATE users SET read_only = ?2 WHERE email = ?1",
        params![email, read_only as i64],
    )?;
    if n == 0 {
        return Err(ApiError::not_found("account"));
    }
    Ok(conn.query_row(
        &format!("SELECT {USER_COLS} FROM users WHERE email = ?1"),
        [&email],
        user_row,
    )?)
}

/// Start a session for `user`; returns the token for the cookie.
pub(crate) fn session_start(
    conn: &mut Connection,
    user: &User,
    previous: Option<&str>,
    now: DateTime<Utc>,
) -> Result<String> {
    // Generate before touching the store. The old token remains valid if any
    // database write (including insertion of its replacement) fails.
    let token = random_hex(32)?;
    let tx = conn.transaction()?;
    tx.execute("DELETE FROM sessions WHERE expires <= ?1", [now_text(now)])?;
    if let Some(previous) = previous {
        session_end(&tx, previous)?;
    }
    tx.execute(
        "INSERT INTO sessions (sha256, user_id, created, expires) VALUES (?1, ?2, ?3, ?4)",
        params![
            sha256_hex([token.as_bytes()]),
            user.id,
            now_text(now),
            now_text(now + SESSION_TTL)
        ],
    )?;
    tx.commit()?;
    Ok(token)
}

/// The account behind a live session token.
pub(crate) fn session_user(
    conn: &Connection,
    token: &str,
    now: DateTime<Utc>,
) -> Result<Option<User>> {
    Ok(conn
        .query_row(
            "SELECT u.id, u.email, u.created, u.password, u.read_only, u.demo FROM sessions s
             JOIN users u ON u.id = s.user_id
             WHERE s.sha256 = ?1 AND s.expires > ?2 AND (u.password IS NOT NULL OR u.demo = 1)",
            params![sha256_hex([token.as_bytes()]), now_text(now)],
            user_row,
        )
        .optional()?)
}

pub(crate) fn session_end(conn: &Connection, token: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM sessions WHERE sha256 = ?1",
        [sha256_hex([token.as_bytes()])],
    )?;
    Ok(())
}

pub(crate) fn list(conn: &Connection) -> Result<Vec<User>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {USER_COLS} FROM users ORDER BY created, email"
    ))?;
    let rows = stmt.query_map([], user_row)?;
    rows.map(|r| r.map_err(ApiError::from)).collect()
}

/// Delete the account and sign it out everywhere.
pub(crate) fn remove(conn: &mut Connection, email: &str) -> Result<User> {
    let email = normalize_email(email)?;
    let tx = conn.transaction()?;
    let user = tx
        .query_row(
            &format!("SELECT {USER_COLS} FROM users WHERE email = ?1"),
            [&email],
            user_row,
        )
        .optional()?
        .ok_or(ApiError::not_found("user"))?;
    tx.execute("DELETE FROM sessions WHERE user_id = ?1", [&user.id])?;
    tx.execute("DELETE FROM users WHERE id = ?1", [&user.id])?;
    tx.commit()?;
    Ok(user)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> (tempfile::TempDir, crate::keys::KeyStore) {
        let dir = tempfile::tempdir().unwrap();
        let ks = crate::keys::KeyStore::open(dir.path().join("server.db")).unwrap();
        (dir, ks)
    }

    #[test]
    fn failed_rotation_preserves_previous_and_expired_sessions() {
        let (_dir, ks) = db();
        let inv = ks.users_invite("session@example.org").unwrap();
        let user = ks
            .users_accept(&inv.token, "correct horse battery")
            .unwrap();
        let previous = ks.session_start(&user).unwrap();
        let mut conn = Connection::open(_dir.path().join("server.db")).unwrap();
        conn.execute(
            "INSERT INTO sessions (sha256, user_id, created, expires) VALUES ('expired', ?1, '2000-01-01', '2000-01-02')",
            [&user.id],
        ).unwrap();
        conn.execute_batch(
            "CREATE TRIGGER refuse_session BEFORE INSERT ON sessions BEGIN
             SELECT RAISE(ABORT, 'injected insert failure'); END;",
        )
        .unwrap();
        assert!(session_start(&mut conn, &user, Some(&previous), Utc::now()).is_err());
        assert!(ks.session_user(&previous).unwrap().is_some());
        let expired: i64 = conn
            .query_row(
                "SELECT count(*) FROM sessions WHERE sha256 = 'expired'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            expired, 1,
            "housekeeping must roll back with the replacement"
        );
        conn.execute_batch("DROP TRIGGER refuse_session").unwrap();
        let replacement = ks.session_replace(&user, Some(&previous)).unwrap();
        assert!(ks.session_user(&previous).unwrap().is_none());
        assert_eq!(ks.session_user(&replacement).unwrap(), Some(user));
        let expired: i64 = conn
            .query_row(
                "SELECT count(*) FROM sessions WHERE sha256 = 'expired'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(expired, 0);
    }

    #[test]
    fn emails_are_normalised() {
        assert_eq!(
            normalize_email("  Ada@Example.ORG ").unwrap(),
            "ada@example.org"
        );
        for bad in [
            "",
            "ada",
            "ada@",
            "@x.org",
            "ada@org",
            "a b@x.org",
            "a<@x.org",
        ] {
            assert!(normalize_email(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn invite_accept_sign_in_and_remove() {
        let (_dir, ks) = db();
        let inv = ks.users_invite("Ada@Example.org").unwrap();
        assert!(!inv.user.active);
        assert!(!format!("{inv:?}").contains(&inv.token));
        // Not active yet: no password works.
        assert_eq!(ks.users_check("ada@example.org", "").unwrap(), None);
        assert_eq!(
            ks.users_invitee(&inv.token).unwrap().unwrap().email,
            "ada@example.org"
        );
        assert!(ks.users_accept(&inv.token, "short").is_err());
        let user = ks
            .users_accept(&inv.token, "correct horse battery")
            .unwrap();
        assert!(user.active);
        // The invite is spent.
        assert!(
            ks.users_accept(&inv.token, "correct horse battery")
                .is_err()
        );
        assert_eq!(
            ks.users_check("ADA@example.org", "wrong password!")
                .unwrap(),
            None
        );
        let signed = ks
            .users_check("ADA@example.org", "correct horse battery")
            .unwrap()
            .unwrap();
        let token = ks.session_start(&signed).unwrap();
        assert_eq!(
            ks.session_user(&token).unwrap().unwrap().email,
            "ada@example.org"
        );
        // A reset invite keeps the old password until accepted, then signs
        // out the old session.
        let again = ks.users_invite("ada@example.org").unwrap();
        assert_eq!(again.user.id, user.id);
        assert!(ks.session_user(&token).unwrap().is_some());
        ks.users_accept(&again.token, "another long password")
            .unwrap();
        assert!(ks.session_user(&token).unwrap().is_none());
        let token = ks.session_start(&user).unwrap();
        ks.session_end(&token).unwrap();
        assert!(ks.session_user(&token).unwrap().is_none());
        let token = ks.session_start(&user).unwrap();
        assert_eq!(ks.users_list().unwrap().len(), 1);
        ks.users_remove("ada@example.org").unwrap();
        assert!(ks.session_user(&token).unwrap().is_none());
        assert!(ks.users_list().unwrap().is_empty());
        assert!(ks.users_remove("ada@example.org").is_err());
    }
}
