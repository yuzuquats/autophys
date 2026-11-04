use actix_web::{http::StatusCode, HttpResponse};
use serde_json::json;

pub struct TentoWebErrorResponse {
  pub code: StatusCode,
  pub reason: String,
  pub details: String,
}

pub trait ToYuzuErrorResponse {
  fn tento_web_error_response(&self) -> TentoWebErrorResponse;
}

impl TentoWebErrorResponse {
  /// Build from the fleet's `"<slug>/<message>"` convention: a machine slug and
  /// an operator-facing sentence packed into one string, split on the FIRST
  /// slash so a message may contain paths.
  ///
  /// The convention predates this crate and is load-bearing — `market-research`
  /// raises `asset_not_found/…`, `tabsaver` raises `session_not_found/…`, and
  /// the ux-test folder raises `session_not_found/…` — but it was being split
  /// in two hand-written places (`so.lona/src/error.rs`,
  /// `tento-ux-test/src/http.rs`) and NOT split in a third, where the slug
  /// shipped welded to the sentence inside an `{ error }` body. One
  /// implementation, here, beside the struct it produces.
  ///
  /// A message with no slash keeps a slug derived from the status, not
  /// `"unknown"`: every caller has already chosen a status, and a category the
  /// client can match on is worth more than a placeholder.
  pub fn from_slug_message(code: StatusCode, message: &str) -> Self {
    match message.split_once('/') {
      Some((slug, details)) if !slug.is_empty() && !slug.contains(' ') => Self {
        code,
        reason: slug.to_string(),
        details: details.to_string(),
      },
      _ => Self {
        code,
        reason: Self::slug_for_status(code).to_string(),
        details: message.to_string(),
      },
    }
  }

  /// The category half derived from the status. Kept here rather than at each
  /// boundary so two of them cannot disagree about what a 409 is called.
  pub fn slug_for_status(code: StatusCode) -> &'static str {
    match code {
      StatusCode::BAD_REQUEST => "bad_request",
      StatusCode::UNAUTHORIZED => "unauthorized",
      StatusCode::FORBIDDEN => "forbidden",
      StatusCode::NOT_FOUND => "not_found",
      StatusCode::CONFLICT => "conflict",
      StatusCode::GONE => "gone",
      StatusCode::PAYLOAD_TOO_LARGE => "payload_too_large",
      StatusCode::UNPROCESSABLE_ENTITY => "validation",
      StatusCode::METHOD_NOT_ALLOWED => "method_not_allowed",
      StatusCode::PRECONDITION_REQUIRED => "precondition_required",
      StatusCode::TOO_MANY_REQUESTS => "rate_limited",
      StatusCode::BAD_GATEWAY => "bad_gateway",
      // Ahead of the 5xx catch-all on purpose: "unavailable" is a retry hint
      // and "internal" is not, and a caller that chose 503 meant the former.
      StatusCode::SERVICE_UNAVAILABLE => "unavailable",
      _ if code.is_server_error() => "internal",
      _ => "request",
    }
  }

  pub fn build(self) -> HttpResponse {
    self.build_with(serde_json::Value::Null)
  }

  /// The envelope plus structured context alongside it.
  ///
  /// A refusal sometimes carries more than a sentence — which change id, which
  /// sha, which threads are blocking a publish — and a surface that has to
  /// choose between the canonical envelope and keeping that context will keep
  /// the context and invent its own body, which is how `{ error, cid, sha }`
  /// came to exist. `reason` and `details` always win a key collision, so the
  /// envelope cannot be shadowed by a context field named after it.
  pub fn build_with(self, extra: serde_json::Value) -> HttpResponse {
    let code = self.code;
    HttpResponse::build(code).json(self.into_body_with(extra))
  }

  /// The envelope as a value, for a producer that does not own an actix
  /// response.
  ///
  /// `localhost.node`'s front is a raw tokio byte-splicing proxy — it cannot
  /// live behind a framework, so it writes status lines as strings and hands a
  /// `serde_json::Value` to its own writer. Without this it had no way to reach
  /// the envelope at all, which is one reason it still spoke `{ error }`.
  pub fn into_body(self) -> serde_json::Value {
    self.into_body_with(serde_json::Value::Null)
  }

  /// The one place the body is assembled. `build_with` is its only other
  /// caller, so the actix exit and the value exit cannot drift apart into two
  /// spellings of the same envelope — which is the failure this crate exists
  /// to end, and it would be an embarrassing one to re-introduce here.
  pub fn into_body_with(self, extra: serde_json::Value) -> serde_json::Value {
    let mut body = serde_json::Map::new();
    if let serde_json::Value::Object(extra) = extra {
      body.extend(extra);
    }
    body.insert("reason".to_string(), json!(self.reason));
    body.insert("details".to_string(), json!(self.details));
    serde_json::Value::Object(body)
  }
}

/// A refusal in the fleet's envelope: `{reason, details}`, where `reason` is
/// the category the status already implies.
///
/// For a surface whose messages are prose rather than the
/// `"<slug>/<sentence>"` convention — the category comes from the status the
/// caller has already chosen, so nothing is parsed. `from_slug_message` is the
/// entry point for the surfaces that do use the convention.
///
/// This pair began crate-local in `commit-review.node`, where it replaced 132
/// hand-built `{ "error": … }` bodies. Six more crates then needed exactly it.
/// Copying it into each would have left the fleet with seven hand-rolled
/// helpers in place of the four hand-rolled splitters this crate was written to
/// retire — the same mechanism one layer up, so it lives here instead.
pub fn api_error(status: StatusCode, message: impl std::fmt::Display) -> HttpResponse {
  api_error_with(status, message, serde_json::Value::Null)
}

/// The same, plus the structured context a refusal carries — which change id,
/// which sha, which threads block a publish. Those keys ride BESIDE the
/// envelope rather than inside the message, which is what let the old inline
/// bodies keep them; losing them was never an option. `reason` and `details`
/// are inserted last, so a context key cannot shadow the envelope.
pub fn api_error_with(
  status: StatusCode,
  message: impl std::fmt::Display,
  extra: serde_json::Value,
) -> HttpResponse {
  TentoWebErrorResponse {
    code: status,
    reason: TentoWebErrorResponse::slug_for_status(status).to_string(),
    details: message.to_string(),
  }
  .build_with(extra)
}

#[cfg(test)]
mod tests {
  use super::*;

  /// The convention is a wire contract shared by three node apps and the
  /// ux-test folder, so the cases that pin it are the ones a message can
  /// actually take: a slug, a message with its own slashes, and prose that
  /// happens to contain one.
  #[test]
  fn splits_on_the_first_slash_only() {
    let e = TentoWebErrorResponse::from_slug_message(
      StatusCode::NOT_FOUND,
      "asset_not_found/market research asset does not exist",
    );
    assert_eq!(e.reason, "asset_not_found");
    assert_eq!(e.details, "market research asset does not exist");

    let path = TentoWebErrorResponse::from_slug_message(
      StatusCode::BAD_REQUEST,
      "invalid_path/a/b/c escapes the root",
    );
    assert_eq!(path.reason, "invalid_path");
    assert_eq!(path.details, "a/b/c escapes the root");
  }

  #[test]
  fn prose_with_a_slash_is_not_a_slug() {
    // The guard that keeps a sentence from becoming a category. Without it,
    // "could not read x/y" would ship `reason: "could not read x"`.
    let e = TentoWebErrorResponse::from_slug_message(
      StatusCode::INTERNAL_SERVER_ERROR,
      "could not read the db/tabsaver.sqlite is locked",
    );
    assert_eq!(e.reason, "internal");
    assert_eq!(e.details, "could not read the db/tabsaver.sqlite is locked");
  }

  #[test]
  fn no_slash_falls_back_to_the_status_category() {
    let e = TentoWebErrorResponse::from_slug_message(StatusCode::CONFLICT, "already in the fleet");
    assert_eq!(e.reason, "conflict");
    assert_eq!(e.details, "already in the fleet");

    let empty = TentoWebErrorResponse::from_slug_message(StatusCode::NOT_FOUND, "/no slug here");
    assert_eq!(empty.reason, "not_found");
    assert_eq!(empty.details, "/no slug here");
  }

  /// The five producers that already used this crate must see no change on the
  /// wire: `build()` routes through `build_with` now, and an extra that is not
  /// an object must add nothing.
  #[test]
  fn build_still_emits_exactly_the_two_fields() {
    use actix_web::body::MessageBody;
    let resp = TentoWebErrorResponse {
      code: StatusCode::UNPROCESSABLE_ENTITY,
      reason: "validation".to_string(),
      details: "id is required".to_string(),
    }
    .build();
    let bytes = resp.into_body().try_into_bytes().unwrap();
    let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(
      body,
      json!({ "reason": "validation", "details": "id is required" })
    );
  }

  #[test]
  fn context_rides_beside_the_envelope_and_cannot_shadow_it() {
    use actix_web::body::MessageBody;
    let resp =
      TentoWebErrorResponse::from_slug_message(StatusCode::CONFLICT, "blocked/two threads")
        .build_with(json!({ "cid": "Iaaa", "threads": ["n1"], "reason": "ignored" }));
    let bytes = resp.into_body().try_into_bytes().unwrap();
    let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(body["cid"], json!("Iaaa"));
    assert_eq!(body["threads"], json!(["n1"]));
    // the envelope wins the collision
    assert_eq!(body["reason"], json!("blocked"));
    assert_eq!(body["details"], json!("two threads"));
  }

  /// The value exit and the actix exit must be the same envelope. They are the
  /// same code path by construction now, and this is what keeps it that way: a
  /// future edit that gives `build_with` its own map builder fails here.
  #[test]
  fn the_value_exit_and_the_actix_exit_agree() {
    use actix_web::body::MessageBody;
    let extra = json!({ "host": "rwc-04", "port": 4713 });
    let value = TentoWebErrorResponse::from_slug_message(
      StatusCode::BAD_GATEWAY,
      "not-running/the app is registered but nothing answers on its port",
    )
    .into_body_with(extra.clone());

    let resp = TentoWebErrorResponse::from_slug_message(
      StatusCode::BAD_GATEWAY,
      "not-running/the app is registered but nothing answers on its port",
    )
    .build_with(extra);
    let bytes = resp.into_body().try_into_bytes().unwrap();
    let served: serde_json::Value = serde_json::from_slice(&bytes).unwrap();

    assert_eq!(value, served);
    assert_eq!(value["reason"], json!("not-running"));
    assert_eq!(value["host"], json!("rwc-04"));
  }

  /// `into_body` is the raw proxy's whole path to the envelope, so the plain
  /// case is worth pinning on its own rather than only through `build`.
  #[test]
  fn into_body_emits_exactly_the_two_fields() {
    let body = TentoWebErrorResponse {
      code: StatusCode::GONE,
      reason: "gone".to_string(),
      details: "the acceptance window closed".to_string(),
    }
    .into_body();
    assert_eq!(
      body,
      json!({ "reason": "gone", "details": "the acceptance window closed" })
    );
  }

  /// The hoisted helper: a status and a sentence, no parsing. `api_error_with`
  /// is what `commit-review.node`'s 37 context-carrying refusals go through.
  #[test]
  fn api_error_takes_its_category_from_the_status() {
    use actix_web::body::MessageBody;
    let bytes = api_error(StatusCode::CONFLICT, "terminal is archived")
      .into_body()
      .try_into_bytes()
      .unwrap();
    let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(
      body,
      json!({ "reason": "conflict", "details": "terminal is archived" })
    );

    // Prose containing a slash stays prose here — this entry point never parses.
    let bytes = api_error_with(
      StatusCode::NOT_FOUND,
      "unknown commit sha a/b",
      json!({ "sha": "a/b" }),
    )
    .into_body()
    .try_into_bytes()
    .unwrap();
    let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(body["reason"], json!("not_found"));
    assert_eq!(body["details"], json!("unknown commit sha a/b"));
    assert_eq!(body["sha"], json!("a/b"));
  }

  #[test]
  fn every_status_a_node_app_raises_has_a_category() {
    for (code, slug) in [
      (StatusCode::BAD_REQUEST, "bad_request"),
      (StatusCode::NOT_FOUND, "not_found"),
      (StatusCode::PAYLOAD_TOO_LARGE, "payload_too_large"),
      (StatusCode::INTERNAL_SERVER_ERROR, "internal"),
      // The four the fleet's admin and proxy surfaces raise. 503 in particular
      // is a server error that must NOT fall through to "internal".
      (StatusCode::METHOD_NOT_ALLOWED, "method_not_allowed"),
      (StatusCode::PRECONDITION_REQUIRED, "precondition_required"),
      (StatusCode::TOO_MANY_REQUESTS, "rate_limited"),
      (StatusCode::SERVICE_UNAVAILABLE, "unavailable"),
    ] {
      assert_eq!(TentoWebErrorResponse::slug_for_status(code), slug);
    }
  }
}
