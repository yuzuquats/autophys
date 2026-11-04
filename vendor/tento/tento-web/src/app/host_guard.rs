use actix_http::{RequestHead, header};
use actix_web::guard::{Guard, GuardContext};

pub fn get_host(req: &RequestHead) -> Option<String> {
  req
    .headers
    .get(header::HOST)
    .and_then(|host_value| host_value.to_str().ok())
    .or_else(|| req.uri.host())
    .and_then(normalize_host)
}

fn normalize_host(host: &str) -> Option<String> {
  let trimmed = host.trim();
  if trimmed.is_empty() {
    return None;
  }

  let without_port = if let Some(rest) = trimmed.strip_prefix('[') {
    let Some((addr, _)) = rest.split_once(']') else {
      return None;
    };
    addr
  } else {
    trimmed
      .split_once(':')
      .map(|(host, _)| host)
      .unwrap_or(trimmed)
  };

  let normalized = without_port.trim_end_matches('.').to_ascii_lowercase();
  if normalized.is_empty() {
    None
  } else {
    Some(normalized)
  }
}

#[doc(hidden)]
pub struct HostGuard {
  host: String,
  override_host: Option<String>,
}

impl HostGuard {
  pub fn new(host: String, override_host: Option<String>) -> Self {
    HostGuard {
      host,
      override_host,
    }
  }

  ///
  /// Given the HTTP head, tries to return the full host name.
  /// ie. tasks.lona.so
  ///
  fn req_uri_host(&self, ctx: &GuardContext<'_>) -> Option<String> {
    if let Some(override_host) = &self.override_host {
      return normalize_host(override_host);
    };

    get_host(ctx.head())
  }

  fn _check(&self, ctx: &GuardContext<'_>) -> bool {
    let Some(req_uri_host) = self.req_uri_host(ctx) else {
      return false;
    };

    // todo: check logic on this
    //
    // req_uri_host = www.lona.so
    // self.host = lona.so
    if !req_uri_host.ends_with(&self.host) {
      return false;
    }

    true
  }
}

impl Guard for HostGuard {
  fn check(&self, ctx: &GuardContext<'_>) -> bool {
    let guard = self._check(ctx);
    // println!("guard -- {} {guard:?}", self.host);
    guard
  }
}

#[cfg(test)]
mod tests {
  use actix_web::{App, HttpResponse, http::header, test as actix_test, web};

  use super::{HostGuard, normalize_host};

  #[test]
  fn normalize_host_strips_port_and_canonicalizes_case() {
    assert_eq!(normalize_host("lona.so"), Some("lona.so".to_string()));
    assert_eq!(
      normalize_host("Rc.LoNa.So:8443"),
      Some("rc.lona.so".to_string())
    );
    assert_eq!(
      normalize_host("calendar.lona.so."),
      Some("calendar.lona.so".to_string())
    );
  }

  #[test]
  fn normalize_host_handles_empty_and_ipv6() {
    assert_eq!(normalize_host(""), None);
    assert_eq!(normalize_host("   "), None);
    assert_eq!(normalize_host("[::1]:8443"), Some("::1".to_string()));
  }

  #[actix_web::test]
  async fn guarded_scopes_fall_through_to_later_matching_host() {
    let app = actix_test::init_service(
      App::new()
        .service(
          web::scope("")
            .guard(HostGuard::new("admin.lona.so".to_string(), None))
            .route(
              "/probe",
              web::get().to(|| async { HttpResponse::Ok().body("admin") }),
            ),
        )
        .service(
          web::scope("")
            .guard(HostGuard::new("lona.so".to_string(), None))
            .route(
              "/probe",
              web::get().to(|| async { HttpResponse::Ok().body("root") }),
            ),
        ),
    )
    .await;

    let req = actix_test::TestRequest::get()
      .uri("/probe")
      .insert_header((header::HOST, "rc.lona.so"))
      .to_request();
    let body = actix_test::call_and_read_body(&app, req).await;

    assert_eq!(body, "root");
  }
}
