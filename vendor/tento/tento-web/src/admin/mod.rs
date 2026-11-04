use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use actix_web::guard::{Guard, GuardContext};
use actix_web::{HttpResponse, web};
use chrono::Utc;
use hmac::{Hmac, Mac};
use rand::{Rng, distr::Alphanumeric, rng};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use subtle::ConstantTimeEq;
use tento_dev::DevMode;
use tento_web_router::api;

use crate::FeBuildVersion;
use tento_core::app_bundle::read_version;

use actix_web::HttpRequest;
use admin_handler_wrapper::AdminHandlerWrapper;

type HmacSha256 = Hmac<Sha256>;

// ============================================================================
// Admin Guard
// ============================================================================

/// Guard that **validates** the admin session.
///
/// Reads the `aid` cookie and verifies it against `AdminService` (the same
/// `is_logged_in` check the handlers used to do inline) via `ctx.app_data()` —
/// the pattern `PrivateApiGuard` already uses. This is the single
/// access-control gate; gated handlers no longer re-check.
///
/// Used two ways via the router DSL:
/// - `[guard = AdminGuard] { … }` — fail ⇒ 404 (hidden; JSON APIs).
/// - `[guard = AdminGuard] { … } else { redirect("…") }` — fail ⇒ 302
///   (HTML pages, redirected to sign-in).
#[derive(Clone)]
pub struct AdminGuard;

impl Guard for AdminGuard {
  fn check(&self, ctx: &GuardContext<'_>) -> bool {
    let Some(service) = ctx.app_data::<web::Data<AdminService>>() else {
      return false;
    };
    // Parse the `aid` cookie across ALL Cookie headers (browsers can split
    // them), using actix's encoded-cookie parsing so the value matches
    // `HttpRequest::cookie("aid")`. Then validate it against the session store.
    ctx
      .head()
      .headers
      .get_all(actix_web::http::header::COOKIE)
      .filter_map(|h| h.to_str().ok())
      .flat_map(|cookies| cookies.split(';'))
      .filter_map(|kv| actix_web::cookie::Cookie::parse_encoded(kv.trim().to_owned()).ok())
      .find(|c| c.name() == "aid")
      .map(|c| service.is_logged_in(c.value()))
      .unwrap_or(false)
  }
}

pub mod admin_handler;
pub mod admin_handler_wrapper;
pub mod api;
pub mod router;
pub mod ux_test;

/// Determine the static host based on the request origin.
///
/// Uses `--` as the delimiter to extract fleet prefixes.
/// - dev--calendar.lona.so -> https://dev--static.lona.so
/// - aws-04--calendar.lona.so -> https://aws-04--static.lona.so
/// - gcp-01--calendar.lona.so -> https://gcp-01--static.lona.so
/// - calendar.lona.so -> https://static.lona.so
pub(crate) fn get_static_host(req: &HttpRequest) -> String {
  let host = req.connection_info().host().to_string();

  // Strip port if present
  let host = host.split(':').next().unwrap_or(&host);

  // Extract prefix before "--" delimiter (e.g. "dev--admin.lona.so" → "dev")
  if let Some(prefix_end) = host.find("--") {
    let prefix = &host[..prefix_end];
    return format!("https://{}--static.lona.so", prefix);
  }

  // Extract subdomain prefix (e.g. "dev.lona.so" → "dev")
  let parts: Vec<&str> = host.split('.').collect();
  if parts.len() > 2 {
    let prefix = parts[0];
    return format!("https://{}--static.lona.so", prefix);
  }

  "https://static.lona.so".to_string()
}

/// Server version passed from bundle configuration.
#[derive(Clone)]
pub struct ServerVersion(pub Option<String>);

/// Server host identifier (e.g., "dev", "gcp-02", "aws-01").
#[derive(Clone)]
pub struct ServerHost(pub Option<String>);

/// Server run mode (e.g., "d", "d+w", "sysd").
#[derive(Clone)]
pub struct ServerMode(pub Option<String>);

/// Alias used to identify the database host target (e.g., "dev").
#[derive(Clone)]
pub struct DatabaseHostAlias(pub Option<String>);

/// Database name parsed from runtime database URL (e.g., "lona-prod").
#[derive(Clone)]
pub struct DatabaseName(pub Option<String>);

/// Bundle path passed from server configuration.
#[derive(Clone)]
pub struct BundlePath(pub Option<PathBuf>);

/// Server start time for uptime tracking.
#[derive(Clone)]
pub struct ServerStartTime(pub Instant);

impl Default for ServerStartTime {
  fn default() -> Self {
    Self(Instant::now())
  }
}

// ============================================================================
// Bundle Version API
// ============================================================================

#[serde_with::skip_serializing_none]
#[derive(Serialize, tento_openapi::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct BundleVersionInfo {
  pub server_version: String,
  pub server_host: Option<String>,
  pub server_mode: Option<String>,
  pub db_host_alias: Option<String>,
  pub db_name: Option<String>,
  pub fe_version: Option<FeBuildVersion>,
}

#[derive(Deserialize, tento_openapi::IntoParams)]
pub struct VersionQuery {
  pub mode: Option<String>,
}

#[api(params(VersionQuery), responses((status = 200, body = BundleVersionInfo)))]
pub async fn get_bundle_version(
  query: web::Query<VersionQuery>,
  server_version_data: web::Data<ServerVersion>,
  server_host_data: web::Data<ServerHost>,
  server_mode_data: web::Data<ServerMode>,
  db_host_alias_data: web::Data<DatabaseHostAlias>,
  db_name_data: web::Data<DatabaseName>,
  bundle_path_data: web::Data<BundlePath>,
) -> HttpResponse {
  let server_version = server_version_data.0.clone().unwrap_or_else(|| {
    read_version()
      .map(|v| v.to_string())
      .unwrap_or_else(|_| "unknown".to_string())
  });

  let server_host = server_host_data.0.clone();
  let server_mode = server_mode_data.0.clone();
  let db_host_alias = db_host_alias_data.0.clone();
  let db_name = db_name_data.0.clone();

  let mode = query
    .mode
    .as_ref()
    .map(|m| DevMode::from_str(m))
    .unwrap_or(DevMode::Prod);

  let target_dir = match mode {
    DevMode::Beta => "target.web.beta",
    DevMode::ReleaseCandidate => "target.web.rc",
    DevMode::Prod => "target.web",
  };

  let fe_version = bundle_path_data.0.as_ref().and_then(|path| {
    let version_path = path.join(format!("html/{}/build-version.json", target_dir));
    FeBuildVersion::load(&version_path).ok()
  });

  HttpResponse::Ok().json(BundleVersionInfo {
    server_version,
    server_host,
    server_mode,
    db_host_alias,
    db_name,
    fe_version,
  })
}

// ============================================================================
// Ping API
// ============================================================================

#[api(responses((status = 200)))]
pub async fn ping(req: actix_web::HttpRequest) -> HttpResponse {
  let dev_mode = DevMode::extract_from_request(&req);
  HttpResponse::Ok()
    .insert_header(("x-lona-dev-mode", dev_mode.to_str()))
    .body("pong")
}

// ============================================================================
// Admin Authentication
// ============================================================================

/// An OTP request for admin login.
#[derive(Clone, Debug)]
pub(crate) struct OtpRequest {
  pub id: String,
  email: String,
  peer_addr: String,
  otp: u64,
  created_at: Instant,
}

impl OtpRequest {
  fn new(email: String, peer_addr: String) -> Self {
    let mut rng = rng();
    let id: String = (&mut rng)
      .sample_iter(&Alphanumeric)
      .take(32)
      .map(char::from)
      .collect();
    let otp = rng.random_range(100_000..999_999);
    OtpRequest {
      id,
      email,
      peer_addr,
      otp,
      created_at: Instant::now(),
    }
  }

  fn is_expired(&self) -> bool {
    self.created_at.elapsed() > Duration::from_secs(15 * 60)
  }

  fn is_valid(&self, email: &str, peer_addr: &str, otp: u64) -> bool {
    let email_match = self.email == email;
    let peer_match = self.peer_addr == peer_addr;
    let otp_match = self.otp == otp;
    let not_expired = !self.is_expired();
    email_match && peer_match && otp_match && not_expired
  }
}

// ============================================================================
// Admin Session Store Trait
// ============================================================================

/// Trait for admin session storage backends.
pub trait AdminSessionStore: Send + Sync {
  /// Create a new session, returning the token to store in the cookie.
  fn create_session(&self, email: &str) -> String;

  /// Check if a token represents a valid, non-expired session.
  fn is_valid(&self, token: &str) -> bool;
}

// ============================================================================
// In-Memory Session Store (for testing/development)
// ============================================================================

/// In-memory session store. Sessions are lost on restart.
/// Useful for testing and development.
#[derive(Clone, Default)]
pub struct InMemorySessionStore {
  tokens: Arc<RwLock<HashSet<String>>>,
}

impl InMemorySessionStore {
  pub fn new() -> Self {
    Self::default()
  }
}

impl AdminSessionStore for InMemorySessionStore {
  fn create_session(&self, _email: &str) -> String {
    let mut rng = rng();
    let token: String = (&mut rng)
      .sample_iter(&Alphanumeric)
      .take(32)
      .map(char::from)
      .collect();

    let mut tokens = self.tokens.write().expect("lock poisoned");
    tokens.insert(token.clone());
    token
  }

  fn is_valid(&self, token: &str) -> bool {
    let tokens = self.tokens.read().expect("lock poisoned");
    tokens.contains(token)
  }
}

// ============================================================================
// Signed Session Store (HMAC-based, persistent across restarts)
// ============================================================================

/// Session expiry duration in days.
const SESSION_EXPIRY_DAYS: u64 = 7;

/// Signed session store using HMAC-SHA256.
/// Sessions survive restarts and include expiration.
///
/// Token format: `{email}.{expiry_unix_timestamp}.{hmac_sha256_hex}`
pub struct SignedSessionStore {
  secret: String,
  expiry_duration: Duration,
}

impl SignedSessionStore {
  pub fn new(secret: String) -> Self {
    Self {
      secret,
      expiry_duration: Duration::from_secs(SESSION_EXPIRY_DAYS * 24 * 60 * 60),
    }
  }

  pub fn with_expiry_days(secret: String, expiry_days: u64) -> Self {
    Self {
      secret,
      expiry_duration: Duration::from_secs(expiry_days * 24 * 60 * 60),
    }
  }

  fn sign(&self, payload: &str) -> String {
    let mut mac =
      HmacSha256::new_from_slice(self.secret.as_bytes()).expect("HMAC can take key of any size");
    mac.update(payload.as_bytes());
    hex::encode(mac.finalize().into_bytes())
  }
}

impl AdminSessionStore for SignedSessionStore {
  fn create_session(&self, email: &str) -> String {
    let expiry = SystemTime::now()
      .duration_since(UNIX_EPOCH)
      .expect("time went backwards")
      .as_secs()
      + self.expiry_duration.as_secs();

    let payload = format!("{}.{}", email, expiry);
    let signature = self.sign(&payload);
    format!("{}.{}", payload, signature)
  }

  fn is_valid(&self, token: &str) -> bool {
    // Split: payload.signature (signature is last segment)
    let Some(dot_pos) = token.rfind('.') else {
      return false;
    };
    let (payload, signature_with_dot) = token.split_at(dot_pos);
    let signature = &signature_with_dot[1..]; // Skip the dot

    // Constant-time signature verification (prevents timing attacks)
    let expected_sig = self.sign(payload);
    let sig_valid: bool = signature.as_bytes().ct_eq(expected_sig.as_bytes()).into();
    if !sig_valid {
      return false;
    }

    // Extract and check expiry (expiry is the last part of the payload)
    let Some(dot_pos) = payload.rfind('.') else {
      return false;
    };
    let expiry_str = &payload[dot_pos + 1..];
    let expiry: u64 = match expiry_str.parse() {
      Ok(v) => v,
      Err(_) => return false,
    };

    let now = SystemTime::now()
      .duration_since(UNIX_EPOCH)
      .expect("time went backwards")
      .as_secs();

    expiry > now
  }
}

/// Admin service handling authentication.
#[derive(Clone)]
pub struct AdminService {
  otp_requests: Arc<RwLock<HashMap<String, OtpRequest>>>,
  session_store: Arc<dyn AdminSessionStore>,
  admin_handler: AdminHandlerWrapper,
}

impl AdminService {
  /// Create a new AdminService with the default in-memory session store.
  /// Sessions will be lost on server restart.
  pub fn new(admin_handler: AdminHandlerWrapper) -> AdminService {
    AdminService {
      otp_requests: Arc::new(RwLock::new(HashMap::new())),
      session_store: Arc::new(InMemorySessionStore::new()),
      admin_handler,
    }
  }

  /// Create a new AdminService with a custom session store.
  /// Use SignedSessionStore for persistent sessions across restarts.
  pub fn with_session_store(
    admin_handler: AdminHandlerWrapper,
    session_store: impl AdminSessionStore + 'static,
  ) -> AdminService {
    AdminService {
      otp_requests: Arc::new(RwLock::new(HashMap::new())),
      session_store: Arc::new(session_store),
      admin_handler,
    }
  }

  pub fn config(&self) -> impl FnOnce(&mut web::ServiceConfig) {
    let service = self.clone();

    move |cfg: &mut web::ServiceConfig| {
      cfg.app_data(web::Data::new(service));
    }
  }

  pub(crate) async fn generate_otp(&self, email: String, peer_addr: String) -> Option<OtpRequest> {
    let req = OtpRequest::new(email.clone(), peer_addr);

    // Check with admin handler (sends email if allowed)
    let allowed = self
      .admin_handler
      .on_generate_two_fac(&email, req.otp)
      .await;
    if !allowed {
      return None;
    }

    // Store the request
    let mut reqs = self.otp_requests.write().expect("lock poisoned");
    reqs.insert(req.id.clone(), req.clone());
    Some(req)
  }

  pub(crate) fn is_logged_in(&self, token: &str) -> bool {
    self.session_store.is_valid(token)
  }

  pub(crate) fn verify_otp(
    &self,
    request_id: &str,
    email: &str,
    peer_addr: &str,
    otp: u64,
  ) -> Option<String> {
    // Check OTP
    {
      let reqs = self.otp_requests.read().expect("lock poisoned");
      let Some(req) = reqs.get(request_id) else {
        tracing::info!("OTP request not found: {}", request_id);
        return None;
      };
      if !req.is_valid(email, peer_addr, otp) {
        tracing::info!("OTP validation failed for {}", email);
        return None;
      }
    }

    // Remove used OTP
    {
      let mut reqs = self.otp_requests.write().expect("lock poisoned");
      reqs.remove(request_id);
    }

    // Create session (pass email for signed sessions)
    let token = self.session_store.create_session(email);
    Some(token)
  }
}

// ============================================================================
// Private API Authentication
// ============================================================================

/// Shared secret for CLI-to-server private API authentication.
///
/// Token format: `{unix_timestamp}.{hmac_hex}`
/// HMAC = HMAC-SHA256(secret, "lona-private-api:{unix_timestamp}")
/// Server validates HMAC and checks timestamp is within 60s tolerance.
pub struct PrivateApiSecret(String);

impl PrivateApiSecret {
  pub fn new(secret: String) -> Self {
    Self(secret)
  }

  fn hmac_for_timestamp(&self, timestamp: i64) -> String {
    let message = format!("lona-private-api:{}", timestamp);
    let mut mac =
      HmacSha256::new_from_slice(self.0.as_bytes()).expect("HMAC can take key of any size");
    mac.update(message.as_bytes());
    hex::encode(mac.finalize().into_bytes())
  }

  /// Generate a bearer token: "{timestamp}.{hmac_hex}"
  pub fn generate_token(&self) -> String {
    let now = Utc::now().timestamp();
    format!("{}.{}", now, self.hmac_for_timestamp(now))
  }

  /// Verify a bearer token is valid and within a 15-minute
  /// tolerance. Used by short-lived CLI calls; 15 min is long
  /// enough for a full e2e test run including slow garmin
  /// per-day syncs without forcing callers to re-mint per
  /// request.
  pub fn verify(&self, token: &str) -> bool {
    let Some((ts_str, hmac_hex)) = token.split_once('.') else {
      return false;
    };
    let Ok(ts) = ts_str.parse::<i64>() else {
      return false;
    };
    let now = Utc::now().timestamp();
    if (now - ts).abs() > 15 * 60 {
      return false;
    }
    let expected = self.hmac_for_timestamp(ts);
    expected.as_bytes().ct_eq(hmac_hex.as_bytes()).into()
  }
}

/// Guard that validates private API bearer tokens via HMAC-SHA256.
pub struct PrivateApiGuard;

impl Guard for PrivateApiGuard {
  fn check(&self, ctx: &GuardContext<'_>) -> bool {
    let Some(secret) = ctx.app_data::<web::Data<PrivateApiSecret>>() else {
      return false;
    };
    ctx
      .head()
      .headers
      .get(actix_web::http::header::AUTHORIZATION)
      .and_then(|h| h.to_str().ok())
      .and_then(|h| h.strip_prefix("Bearer "))
      .map(|token| secret.verify(token))
      .unwrap_or(false)
  }
}

// ============================================================================
// UX-Test Harness Token (cookie minted at logged-in launch)
// ============================================================================

/// Cookie name carrying the ux-test harness token. Set on `.lona.so` so it
/// fans out to every subdomain and survives sign-out (it is distinct from the
/// auth session cookie).
pub const HARNESS_COOKIE: &str = "lona-uxtest";

/// Shared secret for the ux-test harness token.
///
/// Token format: `{unix_timestamp}.{hmac_hex}`,
/// HMAC = HMAC-SHA256(secret, "lona-ux-harness:{unix_timestamp}").
/// Minted by `POST /_/ux-test/token` (which requires a logged-in lona user) and
/// stored in the `lona-uxtest` cookie; the harness routes accept it for up to
/// 12h so a full day of testing survives on a single mint, across the anonymous
/// parts of a test flow.
pub struct HarnessSecret(String);

impl HarnessSecret {
  pub fn new(secret: String) -> Self {
    Self(secret)
  }

  fn hmac_for_timestamp(&self, timestamp: i64) -> String {
    let message = format!("lona-ux-harness:{}", timestamp);
    let mut mac =
      HmacSha256::new_from_slice(self.0.as_bytes()).expect("HMAC can take key of any size");
    mac.update(message.as_bytes());
    hex::encode(mac.finalize().into_bytes())
  }

  /// Mint a token: `"{timestamp}.{hmac_hex}"`.
  pub fn generate_token(&self) -> String {
    let now = Utc::now().timestamp();
    format!("{}.{}", now, self.hmac_for_timestamp(now))
  }

  /// Verify a token's HMAC and that it is within the 12-hour validity window.
  pub fn verify(&self, token: &str) -> bool {
    let Some((ts_str, hmac_hex)) = token.split_once('.') else {
      return false;
    };
    let Ok(ts) = ts_str.parse::<i64>() else {
      return false;
    };
    let now = Utc::now().timestamp();
    if (now - ts).abs() > 12 * 60 * 60 {
      return false;
    }
    let expected = self.hmac_for_timestamp(ts);
    expected.as_bytes().ct_eq(hmac_hex.as_bytes()).into()
  }
}

/// Guard that validates the ux-test harness cookie (`lona-uxtest`) via HMAC.
/// Lets the in-browser harness reach the ux-test routes (even through anonymous
/// test flows) while blocking the unauthenticated public internet.
pub struct HarnessTokenGuard;

impl Guard for HarnessTokenGuard {
  fn check(&self, ctx: &GuardContext<'_>) -> bool {
    let Some(secret) = ctx.app_data::<web::Data<HarnessSecret>>() else {
      return false;
    };
    ctx
      .head()
      .headers
      .get_all(actix_web::http::header::COOKIE)
      .filter_map(|h| h.to_str().ok())
      .flat_map(|cookies| cookies.split(';'))
      .filter_map(|kv| actix_web::cookie::Cookie::parse_encoded(kv.trim().to_owned()).ok())
      .find(|c| c.name() == HARNESS_COOKIE)
      .map(|c| secret.verify(c.value()))
      .unwrap_or(false)
  }
}

// ============================================================================
// Admin Health Response
// ============================================================================

#[serde_with::skip_serializing_none]
#[derive(Serialize, tento_openapi::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AdminHealthResponse {
  pub server_version: String,
  pub uptime_seconds: u64,
  pub hostname: Option<String>,
  pub server_mode: Option<String>,
  pub started_at: String,
}

// ============================================================================
// Admin Routes Response
// ============================================================================

#[derive(Serialize, tento_openapi::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AdminRoutesResponse {
  pub domain: String,
  pub mode: String,
  pub subdomains: Vec<SubdomainRoutes>,
}

#[derive(Serialize, tento_openapi::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SubdomainRoutes {
  pub name: String,
  pub routes: Vec<String>,
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn test_signed_session_store_create_and_validate() {
    let store = SignedSessionStore::new("test-secret-key-12345".to_string());
    let token = store.create_session("admin@example.com");

    // Token should be valid
    assert!(store.is_valid(&token));

    // Token format: email.expiry.signature (email contains a dot)
    // So we expect: admin@example.com.{expiry}.{signature}
    assert!(token.starts_with("admin@example.com."));

    // Verify there's an expiry and signature after the email
    let suffix = token.strip_prefix("admin@example.com.").unwrap();
    let parts: Vec<&str> = suffix.split('.').collect();
    assert_eq!(parts.len(), 2); // expiry.signature
  }

  #[test]
  fn test_signed_session_store_rejects_tampered_token() {
    let store = SignedSessionStore::new("test-secret-key-12345".to_string());
    let token = store.create_session("admin@example.com");

    // Tamper with the email
    let tampered = token.replace("admin@example.com", "hacker@evil.com");
    assert!(!store.is_valid(&tampered));

    // Tamper with the signature
    let mut chars: Vec<char> = token.chars().collect();
    if let Some(last) = chars.last_mut() {
      *last = if *last == 'a' { 'b' } else { 'a' };
    }
    let tampered: String = chars.into_iter().collect();
    assert!(!store.is_valid(&tampered));
  }

  #[test]
  fn test_signed_session_store_rejects_expired_token() {
    // Create store with 0 day expiry (immediate expiration)
    let store = SignedSessionStore::with_expiry_days("test-secret-key-12345".to_string(), 0);
    let token = store.create_session("admin@example.com");

    // Token should be invalid (expired immediately)
    assert!(!store.is_valid(&token));
  }

  #[test]
  fn test_signed_session_store_different_secrets() {
    let store1 = SignedSessionStore::new("secret-one".to_string());
    let store2 = SignedSessionStore::new("secret-two".to_string());

    let token = store1.create_session("admin@example.com");

    // Token valid with same secret
    assert!(store1.is_valid(&token));

    // Token invalid with different secret
    assert!(!store2.is_valid(&token));
  }

  #[test]
  fn test_signed_session_store_malformed_tokens() {
    let store = SignedSessionStore::new("test-secret".to_string());

    // No dots
    assert!(!store.is_valid("nodots"));

    // Only one dot
    assert!(!store.is_valid("one.dot"));

    // Empty string
    assert!(!store.is_valid(""));

    // Invalid expiry (non-numeric)
    assert!(!store.is_valid("email.notanumber.signature"));
  }

  #[test]
  fn test_in_memory_session_store() {
    let store = InMemorySessionStore::new();

    // Create session
    let token = store.create_session("admin@example.com");
    assert!(store.is_valid(&token));

    // Random token should be invalid
    assert!(!store.is_valid("random-invalid-token"));

    // Multiple sessions work
    let token2 = store.create_session("other@example.com");
    assert!(store.is_valid(&token));
    assert!(store.is_valid(&token2));
  }

  #[test]
  fn test_get_static_host_prefix_extraction() {
    // Helper to simulate request host extraction logic
    fn extract_static_host(host: &str) -> String {
      let host = host.split(':').next().unwrap_or(host);
      if let Some(prefix_end) = host.find("--") {
        let prefix = &host[..prefix_end];
        return format!("https://{}--static.lona.so", prefix);
      }
      let parts: Vec<&str> = host.split('.').collect();
      if parts.len() > 2 {
        let prefix = parts[0];
        return format!("https://{}--static.lona.so", prefix);
      }
      "https://static.lona.so".to_string()
    }

    // Any prefix before -- works
    assert_eq!(
      extract_static_host("dev--calendar.lona.so"),
      "https://dev--static.lona.so"
    );
    assert_eq!(
      extract_static_host("aws-04--calendar.lona.so"),
      "https://aws-04--static.lona.so"
    );
    assert_eq!(
      extract_static_host("aws-99--ui.lona.so"),
      "https://aws-99--static.lona.so"
    );
    assert_eq!(
      extract_static_host("gcp-01--static.lona.so"),
      "https://gcp-01--static.lona.so"
    );
    assert_eq!(
      extract_static_host("custom--app.lona.so"),
      "https://custom--static.lona.so"
    );

    // Subdomain-style hosts extract prefix
    assert_eq!(
      extract_static_host("calendar.lona.so"),
      "https://calendar--static.lona.so"
    );
    assert_eq!(
      extract_static_host("dev.lona.so"),
      "https://dev--static.lona.so"
    );

    // Bare domain means production static host
    assert_eq!(extract_static_host("lona.so"), "https://static.lona.so");

    // With port
    assert_eq!(
      extract_static_host("aws-04--ui.lona.so:8080"),
      "https://aws-04--static.lona.so"
    );
    assert_eq!(
      extract_static_host("dev.lona.so:8080"),
      "https://dev--static.lona.so"
    );
  }

  #[test]
  fn test_private_api_secret_generate_and_verify() {
    let secret = PrivateApiSecret::new("test-private-secret".to_string());
    let token = secret.generate_token();
    assert!(secret.verify(&token));
  }

  #[test]
  fn test_private_api_secret_rejects_wrong_secret() {
    let secret1 = PrivateApiSecret::new("secret-one".to_string());
    let secret2 = PrivateApiSecret::new("secret-two".to_string());
    let token = secret1.generate_token();
    assert!(secret1.verify(&token));
    assert!(!secret2.verify(&token));
  }

  #[test]
  fn test_private_api_secret_rejects_tampered_token() {
    let secret = PrivateApiSecret::new("test-private-secret".to_string());
    let token = secret.generate_token();

    // Tamper with the HMAC
    let mut chars: Vec<char> = token.chars().collect();
    if let Some(last) = chars.last_mut() {
      *last = if *last == 'a' { 'b' } else { 'a' };
    }
    let tampered: String = chars.into_iter().collect();
    assert!(!secret.verify(&tampered));
  }

  #[test]
  fn test_private_api_secret_rejects_malformed_tokens() {
    let secret = PrivateApiSecret::new("test-private-secret".to_string());
    assert!(!secret.verify(""));
    assert!(!secret.verify("nodot"));
    assert!(!secret.verify("notanumber.abcdef"));
  }
}
