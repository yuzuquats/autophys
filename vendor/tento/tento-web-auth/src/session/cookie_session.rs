use std::collections::HashMap;

use actix_session::storage::{
  SessionKey, SessionStore, {LoadError, SaveError, UpdateError},
};
use actix_web::cookie::time::Duration;
use anyhow::Error;
type SessionState = HashMap<String, String>;

/// The session key holding a sealed session's expiry, in unix seconds
/// (JSON-encoded, as `Session::insert` writes every value).
pub const SESSION_EXPIRES_AT_KEY: &str = "tento.session.expires_at";

#[derive(Default, Clone)]
#[non_exhaustive]
pub struct LonaCookieSessionStore;

/// `state`, or no session when it carries an expiry ([`SESSION_EXPIRES_AT_KEY`])
/// that has passed or cannot be read. The cookie's own `Max-Age` only tells the
/// browser when to drop it; a sealed value copied out of the browser carries
/// no deadline of its own, so a session minted outside sign-in (`lona-admin
/// ux.login-cookie`) seals one and this enforces it. A session without the key
/// (every real sign-in) is unchanged.
fn unexpired(state: SessionState) -> Option<SessionState> {
  let Some(raw) = state.get(SESSION_EXPIRES_AT_KEY) else {
    return Some(state);
  };
  let expires_at: i64 = serde_json::from_str(raw).ok()?;
  let now = std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .ok()?
    .as_secs() as i64;
  (now < expires_at).then_some(state)
}

impl SessionStore for LonaCookieSessionStore {
  async fn load(&self, session_key: &SessionKey) -> Result<Option<SessionState>, LoadError> {
    let state: SessionState = serde_json::from_str(session_key.as_ref())
      .map_err(anyhow::Error::new)
      .map_err(LoadError::Deserialization)?;
    Ok(unexpired(state))
  }

  async fn save(
    &self,
    session_state: SessionState,
    _ttl: &Duration,
  ) -> Result<SessionKey, SaveError> {
    let session_key = serde_json::to_string(&session_state)
      .map_err(anyhow::Error::new)
      .map_err(SaveError::Serialization)?;

    session_key
      .try_into()
      .map_err(Into::into)
      .map_err(SaveError::Other)
  }

  async fn update(
    &self,
    _session_key: SessionKey,
    session_state: SessionState,
    ttl: &Duration,
  ) -> Result<SessionKey, UpdateError> {
    self
      .save(session_state, ttl)
      .await
      .map_err(|err| match err {
        SaveError::Serialization(err) => UpdateError::Serialization(err),
        SaveError::Other(err) => UpdateError::Other(err),
      })
  }

  async fn update_ttl(&self, _session_key: &SessionKey, _ttl: &Duration) -> Result<(), Error> {
    Ok(())
  }

  async fn delete(&self, _session_key: &SessionKey) -> Result<(), anyhow::Error> {
    Ok(())
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn now_secs() -> i64 {
    std::time::SystemTime::now()
      .duration_since(std::time::UNIX_EPOCH)
      .unwrap()
      .as_secs() as i64
  }

  /// The session map a sealed cookie carries, as `Session::insert` writes it
  /// (each value JSON-encoded), with an optional expiry.
  fn sealed_state(expires_at: Option<i64>) -> SessionKey {
    let mut state: SessionState = HashMap::from([(
      "actix_identity.user_id".to_string(),
      serde_json::to_string("user-123").unwrap(),
    )]);
    if let Some(at) = expires_at {
      state.insert(
        SESSION_EXPIRES_AT_KEY.to_string(),
        serde_json::to_string(&at).unwrap(),
      );
    }
    serde_json::to_string(&state).unwrap().try_into().unwrap()
  }

  fn load(key: &SessionKey) -> Option<SessionState> {
    futures::executor::block_on(LonaCookieSessionStore.load(key)).unwrap()
  }

  /// A session sealed with an expiry (`lona-admin ux.login-cookie`) is no
  /// session once it has passed: a copied value stops logging anyone in.
  #[test]
  fn a_sealed_session_past_its_expiry_loads_as_no_session() {
    assert_eq!(load(&sealed_state(Some(now_secs() - 1))), None);
  }

  #[test]
  fn a_sealed_session_before_its_expiry_loads() {
    let state = load(&sealed_state(Some(now_secs() + 3600))).expect("session");
    assert!(state.contains_key("actix_identity.user_id"));
  }

  /// A real sign-in session carries no expiry key and loads as before.
  #[test]
  fn a_session_without_an_expiry_loads_unchanged() {
    let state = load(&sealed_state(None)).expect("session");
    assert_eq!(state.len(), 1);
  }

  /// An expiry the store cannot read fails closed.
  #[test]
  fn an_unreadable_expiry_loads_as_no_session() {
    let key: SessionKey = serde_json::to_string(&HashMap::from([(
      SESSION_EXPIRES_AT_KEY.to_string(),
      "\"soon\"".to_string(),
    )]))
    .unwrap()
    .try_into()
    .unwrap();
    assert_eq!(load(&key), None);
  }
}
