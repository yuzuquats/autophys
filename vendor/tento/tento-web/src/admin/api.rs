const HEADER: &str = include_str!("header.html");

/// Generate HTML for an admin page.
fn admin_page_html(static_host: &str, title: &str, page: &str) -> String {
  format!(
    r#"{header}
<title>{title}</title>
<link rel="stylesheet" href="{static_host}/css/colors.css">
<script src="{static_host}/admin/{page}/index.anon.root.js" type="module"></script>"#,
    header = HEADER,
    title = title,
    static_host = static_host,
    page = page,
  )
}

pub mod dashboard {
  pub mod get {
    use actix_web::{HttpRequest, HttpResponse, Responder, http::header};
    use tento_web_router::api;

    use crate::admin::{api::admin_page_html, get_static_host};

    // Auth is enforced by AdminGuard on the route (302s to sign-in on failure),
    // so the handler only runs for a validated session.
    #[api(responses((status = 200)))]
    pub async fn route(req: HttpRequest) -> impl Responder {
      let static_host = get_static_host(&req);
      let html = admin_page_html(&static_host, "Admin", "app");

      HttpResponse::Ok()
        .insert_header((header::CONTENT_TYPE, "text/html; charset=utf-8"))
        .body(html)
    }
  }
}

pub mod signin {
  pub mod get {
    use actix_web::{HttpRequest, HttpResponse, Responder, http::header};
    use tento_web_router::api;

    use crate::admin::{api::admin_page_html, get_static_host};

    #[api(responses((status = 200)))]
    pub async fn route(req: HttpRequest) -> impl Responder {
      let static_host = get_static_host(&req);
      let html = admin_page_html(&static_host, "Admin Login", "signin");

      HttpResponse::Ok()
        .insert_header((header::CONTENT_TYPE, "text/html; charset=utf-8"))
        .body(html)
    }
  }

  pub mod post {
    use actix_web::cookie::Cookie as AwCookie;
    use actix_web::{HttpRequest, HttpResponse, Responder, web};
    use serde::Deserialize;
    use tento_web_router::api;

    use crate::admin::AdminService;

    #[derive(Deserialize, tento_openapi::ToSchema)]
    pub struct EmailForm {
      email: String,
    }

    #[api(request_body = EmailForm, responses((status = 200), (status = 401)))]
    pub async fn route(
      service: web::Data<AdminService>,
      req: HttpRequest,
      body: web::Json<EmailForm>,
    ) -> impl Responder {
      let peer_addr = req
        .connection_info()
        .peer_addr()
        .unwrap_or("unknown")
        .to_string();

      let Some(otp_req) = service.generate_otp(body.email.clone(), peer_addr).await else {
        return HttpResponse::Unauthorized().finish();
      };

      // Set cookie with request ID
      let cookie = AwCookie::build("oid", otp_req.id.clone())
        .path("/_/admin")
        .http_only(true)
        .same_site(actix_web::cookie::SameSite::Lax)
        .finish();

      HttpResponse::Ok().cookie(cookie).finish()
    }
  }
}

pub mod verify {
  pub mod get {
    use actix_web::{HttpRequest, HttpResponse, Responder, http::header};
    use tento_web_router::api;

    use crate::admin::{api::admin_page_html, get_static_host};

    #[api(responses((status = 200)))]
    pub async fn route(req: HttpRequest) -> impl Responder {
      let static_host = get_static_host(&req);
      let html = admin_page_html(&static_host, "Enter Code", "verify");

      HttpResponse::Ok()
        .insert_header((header::CONTENT_TYPE, "text/html; charset=utf-8"))
        .body(html)
    }
  }
}

pub mod denied {
  pub mod get {
    use actix_web::{HttpRequest, HttpResponse, Responder, http::header};
    use tento_web_router::api;

    use crate::admin::{api::admin_page_html, get_static_host};

    #[api(responses((status = 200)))]
    pub async fn route(req: HttpRequest) -> impl Responder {
      let static_host = get_static_host(&req);
      let html = admin_page_html(&static_host, "Access Denied", "denied");

      HttpResponse::Ok()
        .insert_header((header::CONTENT_TYPE, "text/html; charset=utf-8"))
        .body(html)
    }
  }
}

pub mod invalid {
  pub mod get {
    use actix_web::{HttpRequest, HttpResponse, Responder, http::header};
    use tento_web_router::api;

    use crate::admin::{api::admin_page_html, get_static_host};

    #[api(responses((status = 200)))]
    pub async fn route(req: HttpRequest) -> impl Responder {
      let static_host = get_static_host(&req);
      let html = admin_page_html(&static_host, "Invalid Code", "invalid");

      HttpResponse::Ok()
        .insert_header((header::CONTENT_TYPE, "text/html; charset=utf-8"))
        .body(html)
    }
  }
}

pub mod two_fac {
  pub mod post {
    use actix_web::cookie::Cookie as AwCookie;
    use actix_web::{HttpRequest, HttpResponse, Responder, web};
    use serde::Deserialize;
    use tento_web_router::api;

    use crate::admin::AdminService;

    #[derive(Deserialize, tento_openapi::ToSchema)]
    pub struct OtpForm {
      email: String,
      code: String,
    }

    #[api(request_body = OtpForm, responses((status = 200), (status = 401)))]
    pub async fn route(
      service: web::Data<AdminService>,
      req: HttpRequest,
      body: web::Json<OtpForm>,
    ) -> impl Responder {
      let peer_addr = req
        .connection_info()
        .peer_addr()
        .unwrap_or("unknown")
        .to_string();

      let Some(request_id) = req.cookie("oid").map(|c| c.value().to_string()) else {
        return HttpResponse::Unauthorized().finish();
      };

      let otp: u64 = match body.code.parse() {
        Ok(v) => v,
        Err(_) => {
          return HttpResponse::Unauthorized().finish();
        }
      };

      let Some(token) = service.verify_otp(&request_id, &body.email, &peer_addr, otp) else {
        return HttpResponse::Unauthorized().finish();
      };

      // Set admin session cookie
      let cookie = AwCookie::build("aid", token)
        .path("/_/admin")
        .http_only(true)
        .secure(true) // HTTPS only - prevents transmission over HTTP
        .same_site(actix_web::cookie::SameSite::Lax)
        .max_age(actix_web::cookie::time::Duration::days(7)) // Browser-enforced expiry
        .finish();

      HttpResponse::Ok().cookie(cookie).finish()
    }
  }
}

pub mod health {
  pub mod get {
    use actix_web::{HttpResponse, web};
    use tento_web_router::api;

    use crate::admin::{
      AdminHealthResponse, ServerHost, ServerMode, ServerStartTime, ServerVersion,
    };
    use tento_core::app_bundle::read_version;

    // Auth is enforced by AdminGuard on the route (404s on failure); this only
    // runs for a validated session.
    #[api(responses((status = 200, body = AdminHealthResponse)))]
    pub async fn route(
      server_version_data: web::Data<ServerVersion>,
      server_host_data: web::Data<ServerHost>,
      server_mode_data: web::Data<ServerMode>,
      server_start_time: web::Data<ServerStartTime>,
    ) -> HttpResponse {
      let server_version = server_version_data.0.clone().unwrap_or_else(|| {
        read_version()
          .map(|v| v.to_string())
          .unwrap_or_else(|_| "unknown".to_string())
      });

      let uptime_seconds = server_start_time.0.elapsed().as_secs();
      let started_at = chrono::Utc::now() - chrono::Duration::seconds(uptime_seconds as i64);

      HttpResponse::Ok().json(AdminHealthResponse {
        server_version,
        uptime_seconds,
        hostname: server_host_data.0.clone(),
        server_mode: server_mode_data.0.clone(),
        started_at: started_at.to_rfc3339(),
      })
    }
  }
}

pub mod logs {
  pub mod get {
    use actix_web::{HttpRequest, HttpResponse, Responder, http::header};
    use tento_web_router::api;

    use crate::admin::{api::admin_page_html, get_static_host};

    // Auth is enforced by AdminGuard on the route (302s to sign-in on failure),
    // so the handler only runs for a validated session.
    #[api(responses((status = 200)))]
    pub async fn route(req: HttpRequest) -> impl Responder {
      let static_host = get_static_host(&req);
      let html = admin_page_html(&static_host, "Logs", "app");

      HttpResponse::Ok()
        .insert_header((header::CONTENT_TYPE, "text/html; charset=utf-8"))
        .body(html)
    }
  }
}

pub mod routes_page {
  pub mod get {
    use actix_web::{HttpRequest, HttpResponse, Responder, http::header};
    use tento_web_router::api;

    use crate::admin::{api::admin_page_html, get_static_host};

    // Auth is enforced by AdminGuard on the route (302s to sign-in on failure),
    // so the handler only runs for a validated session.
    #[api(responses((status = 200)))]
    pub async fn route(req: HttpRequest) -> impl Responder {
      let static_host = get_static_host(&req);
      let html = admin_page_html(&static_host, "Admin", "app");

      HttpResponse::Ok()
        .insert_header((header::CONTENT_TYPE, "text/html; charset=utf-8"))
        .body(html)
    }
  }
}

pub mod ux_tests_page {
  pub mod get {
    use actix_web::{HttpRequest, HttpResponse, Responder, http::header};
    use tento_web_router::api;

    use crate::admin::{api::admin_page_html, get_static_host};

    // Auth is enforced by AdminGuard on the route (302s to sign-in on failure),
    // so the handler only runs for a validated session.
    #[api(responses((status = 200)))]
    pub async fn route(req: HttpRequest) -> impl Responder {
      let static_host = get_static_host(&req);
      let html = admin_page_html(&static_host, "UX Tests", "app");

      HttpResponse::Ok()
        .insert_header((header::CONTENT_TYPE, "text/html; charset=utf-8"))
        .body(html)
    }
  }
}

pub mod routes {
  pub mod get {
    use actix_web::{HttpRequest, HttpResponse, web};
    use serde::Deserialize;
    use tento_dev::DevMode;
    use tento_openapi::IntoParams;
    use tento_web_router::api;

    use crate::admin::{AdminRoutesResponse, BundlePath, SubdomainRoutes};
    use crate::service::routes::DomainedRoutes;

    #[derive(Deserialize, IntoParams)]
    pub struct RoutesQuery {
      pub mode: Option<String>,
    }

    /// Extract the base domain from a request host.
    ///
    /// Examples:
    /// - dev.lona.so -> lona.so
    /// - aws-06--calendar.lona.so -> lona.so
    /// - calendar.lona.so -> lona.so
    /// - lona.so -> lona.so
    fn extract_base_domain(host: &str) -> String {
      // Strip port if present
      let host_without_port = host.split(':').next().unwrap_or(host);

      let parts: Vec<&str> = host_without_port.split('.').collect();

      // For domains like lona.so (2 parts), return as-is
      if parts.len() <= 2 {
        return host_without_port.to_string();
      }

      // For 3+ parts, return the last 2 parts (root domain)
      parts[parts.len() - 2..].join(".")
    }

    // Auth is enforced by AdminGuard on the route (404s on failure); this only
    // runs for a validated session.
    #[api(
      params(RoutesQuery),
      responses((status = 200, body = AdminRoutesResponse), (status = 404), (status = 500))
    )]
    pub async fn route(
      req: HttpRequest,
      query: web::Query<RoutesQuery>,
      bundle_path_data: web::Data<BundlePath>,
    ) -> HttpResponse {
      let Some(bundle_path) = &bundle_path_data.0 else {
        return HttpResponse::InternalServerError().body("Bundle path not configured");
      };

      // Determine mode from query parameter
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

      // Get domain from request host
      let host = req.connection_info().host().to_string();
      let domain = extract_base_domain(&host);

      let routes_path = bundle_path.join("html").join(target_dir).join(&domain);
      if !routes_path.exists() {
        return HttpResponse::NotFound().body(format!("Routes not found: {routes_path:?}"));
      }

      // Use existing DomainedRoutes to enumerate
      let domained_routes = DomainedRoutes::new(&routes_path);
      let mut subdomains: Vec<SubdomainRoutes> = domained_routes
        .list_routes()
        .into_iter()
        .map(|(name, routes)| SubdomainRoutes { name, routes })
        .collect();

      // Sort by name for consistent output (root domain first, then alphabetically)
      subdomains.sort_by(|a, b| {
        if a.name.is_empty() {
          std::cmp::Ordering::Less
        } else if b.name.is_empty() {
          std::cmp::Ordering::Greater
        } else {
          a.name.cmp(&b.name)
        }
      });

      HttpResponse::Ok().json(AdminRoutesResponse {
        domain,
        mode: mode.to_str().to_string(),
        subdomains,
      })
    }

    #[cfg(test)]
    mod tests {
      use super::*;

      #[test]
      fn test_extract_base_domain() {
        assert_eq!(extract_base_domain("lona.so"), "lona.so");
        assert_eq!(extract_base_domain("lona.so:8080"), "lona.so");
        assert_eq!(extract_base_domain("dev.lona.so"), "lona.so");
        assert_eq!(extract_base_domain("dev.lona.so:443"), "lona.so");
        assert_eq!(extract_base_domain("calendar.lona.so"), "lona.so");
        assert_eq!(extract_base_domain("aws-06--calendar.lona.so"), "lona.so");
        assert_eq!(extract_base_domain("dev--calendar.lona.so"), "lona.so");
      }
    }
  }
}
