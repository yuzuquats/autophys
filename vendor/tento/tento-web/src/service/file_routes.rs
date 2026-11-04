use std::future::Future;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::pin::Pin;

use actix_files::NamedFile;
use actix_http::StatusCode;
use actix_http::header::{HeaderName, HeaderValue};
use actix_web::body::BoxBody;
use actix_web::http::{self, Method};
use actix_web::{HttpMessage, HttpRequest, Responder};
use actix_web::{
  HttpResponse,
  dev::{
    AppService, HttpServiceFactory, ResourceDef, Service, ServiceFactory, ServiceRequest,
    ServiceResponse,
  },
};
use percent_encoding::{NON_ALPHANUMERIC, utf8_percent_encode};
use tento_dev::{DevMode, FeMode};
use tento_web_auth::ServiceViewerContext;

use crate::client::state::{BuildState, ThreadSpecificBuildState};
use crate::service::routes::{DomainedRoutes, ResourceBehavior};
use crate::service::template_handler::TemplateHandlerRegistry;

use tento_web_files::domain_type::DomainType;

pub type LocalBoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + 'a>>;

pub struct FileRoutes {
  state: ThreadSpecificBuildState,
  uses_identity: bool,
}

impl FileRoutes {
  pub fn new(state: &BuildState, uses_identity: bool) -> Self {
    FileRoutes {
      state: state.thread_specific(),
      uses_identity,
    }
  }
}

impl HttpServiceFactory for FileRoutes {
  fn register(self, config: &mut AppService) {
    let rdef: ResourceDef = if config.is_root() {
      ResourceDef::root_prefix("")
    } else {
      ResourceDef::prefix("")
    };
    config.register_service(rdef, None, self, None)
  }
}

impl ServiceFactory<ServiceRequest> for FileRoutes {
  type Response = ServiceResponse;
  type Error = actix_web::error::Error;
  type Config = ();
  type Service = FileRoutesService;
  type InitError = ();
  type Future = LocalBoxFuture<'static, Result<Self::Service, Self::InitError>>;

  fn new_service(&self, _: ()) -> Self::Future {
    let state = self.state.clone();
    let uses_identity = self.uses_identity;
    Box::pin(async move {
      Ok(FileRoutesService {
        state,
        uses_identity,
      })
    })
  }
}

#[derive(Clone, Debug)]
pub struct FileRoutesService {
  state: ThreadSpecificBuildState,
  uses_identity: bool,
}

impl Service<ServiceRequest> for FileRoutesService {
  type Response = ServiceResponse<BoxBody>;
  type Error = actix_web::error::Error;
  type Future = LocalBoxFuture<'static, Result<Self::Response, Self::Error>>;

  actix_web::dev::always_ready!();

  fn call(&self, req: ServiceRequest) -> Self::Future {
    let is_method_valid = matches!(*req.method(), Method::HEAD | Method::GET);
    let mut this = self.clone();
    Box::pin(async move {
      if !is_method_valid {
        return Ok(
          req.into_response(
            HttpResponse::MethodNotAllowed()
              .body("Request did not meet this resource's requirements."),
          ),
        );
      }

      let uses_identity = this.uses_identity;
      let dev_mode = DevMode::extract_from_service_request(&req);
      let fe_mode = FeMode::extract_from_service_request(&req);
      // An explicit `?fe=…` is an opt-in we persist as a cookie below so the
      // choice sticks across navigations that omit the query param.
      let fe_query_override = FeMode::query_override_from_service_request(&req);
      let subdomain = DomainType::extract_from_service_request(&req);
      let should_noindex_blog = matches!(dev_mode, DevMode::Beta | DevMode::ReleaseCandidate)
        && matches!(&subdomain, DomainType::SubDomain { name } if name == "blog");
      let request_pattern = req.match_info().unprocessed().to_owned();
      let request_pattern_trimmed = request_pattern.trim_end_matches("/");

      // `/js/m/**` → the shared, content-addressed module store, served
      // stage/subdomain-independently with an immutable cache. (Hashes ⇒ the
      // bytes at a URL never change.)
      if crate::rate_limit::is_static_module_path(request_pattern_trimmed) {
        let rel = request_pattern_trimmed.trim_start_matches('/');
        let path = this.state.module_store_root.join(rel);
        let client_req = req.request().clone();
        let resp = match file_to_response(&client_req, &path).await {
          Some(mut resp) => {
            resp.headers_mut().insert(
              HeaderName::from_static("cache-control"),
              HeaderValue::from_static("public, max-age=31536000, immutable"),
            );
            resp
          }
          None => HttpResponse::NotFound().finish(),
        };
        return Ok(req.into_response(resp));
      }

      let routes = this.routes(&dev_mode);

      let mut resp = make_response(
        request_pattern_trimmed,
        routes,
        subdomain.clone(),
        uses_identity,
        fe_mode,
        req,
      )
      .await?;

      resp.headers_mut().append(
        HeaderName::from_lowercase(b"x-lona-dev-mode").unwrap(),
        HeaderValue::from_bytes(dev_mode.to_str().as_bytes()).unwrap(),
      );

      apply_document_cache_policy(&mut resp);

      // Mutable-stage bundle entries (`d+w` rebuilds Beta in place; rc
      // redeploys under the same URLs) carry no content hash, and with no
      // Cache-Control the browser heuristically caches them — a normal reload
      // revalidates only the document, so a tab can keep executing a
      // long-gone bundle indefinitely (2026-08-05: an operator chased an
      // already-fixed bug through a stale cached bundle for a full day).
      // `no-cache` forces revalidation; NamedFile's conditional GETs turn an
      // unchanged file into a cheap 304. Prod keeps heuristic caching: its
      // revalidation cost/benefit is a separate decision.
      if matches!(dev_mode, DevMode::Beta | DevMode::ReleaseCandidate)
        && (request_pattern_trimmed.ends_with(".root.js")
          || request_pattern_trimmed.ends_with(".root.js.map"))
      {
        resp.headers_mut().insert(
          HeaderName::from_static("cache-control"),
          HeaderValue::from_static("no-cache"),
        );
      }

      if should_noindex_blog {
        resp.headers_mut().append(
          HeaderName::from_lowercase(b"x-robots-tag").unwrap(),
          HeaderValue::from_static("noindex, nofollow, noarchive"),
        );
      }

      // Persist an explicit `?fe=…` choice (covers both the unbundled and
      // bundled responses make_response returned). The query is the opt-in
      // action; the cookie carries it forward to navigations without the param.
      // `?fe=bundled` opts back out the same way. Max-Age is one year (seconds).
      if let Some(mode) = fe_query_override
        && let Ok(value) = HeaderValue::from_str(&format!(
          "fe-mode={}; Path=/; Max-Age=31536000; SameSite=Lax",
          mode.to_str()
        ))
      {
        resp
          .headers_mut()
          .append(HeaderName::from_static("set-cookie"), value);
      }

      Ok(resp)
    })
  }
}

async fn make_response(
  request_pattern_trimmed: &str,
  routes: &DomainedRoutes,
  subdomain: DomainType,
  uses_identity: bool,
  fe_mode: FeMode,
  req: ServiceRequest,
) -> Result<ServiceResponse, actix_web::Error> {
  let client_req = req.request();

  // 1) Check if a signed in route exists
  //
  if let Some(resource_group) = routes.find_resource_group(&subdomain, request_pattern_trimmed) {
    // FeMode::Unbundled — if this route entry has a `*.unbundled.html` sibling
    // (the import-map manifest), serve it instead of the bundled entry HTML.
    // The modules it references are served from the store at `/js/m/**`.
    if fe_mode == FeMode::Unbundled {
      // Serve the unbundled manifest for the SAME entry the bundled path below
      // would pick for this viewer: a logged-in user → the logged-in entry (e.g.
      // the calendar), an anon user → the anonymous one. Skip when the viewer
      // would be redirected (onboarding/subscription) so unbundled mode can't
      // bypass it. The old `anonymous.or(logged_in)` served logged-in users the
      // anon manifest — or, lacking one, fell through to the bundle.
      //
      // Only ASK when identity is on. `ServiceViewerContext::extract` unwraps an
      // extension that `auth.viewer_context_mw()` installs, and that middleware
      // is wrapped only on the `FileRoutes::new(state, true)` branch — so on a
      // no-auth app (every loopback miniapp) this panicked the worker and actix
      // dropped the connection, making `?fe=unbundled` an empty reply on a
      // server whose bundled path answered 200. Without identity every viewer is
      // anon and nothing can redirect, which is exactly `None` here.
      let vc = uses_identity.then(|| ServiceViewerContext::extract(&req.extensions()));
      if vc.as_ref().and_then(|vc| vc.redirect()).is_none() {
        let entry = if vc.as_ref().is_some_and(|vc| vc.is_logged_in()) {
          resource_group
            .logged_in
            .as_ref()
            .or(resource_group.anonymous.as_ref())
        } else {
          resource_group
            .anonymous
            .as_ref()
            .or(resource_group.logged_in.as_ref())
        };
        if let Some(entry) = entry {
          // Resolve a relative `File` descriptor (e.g. sheet/{id}/index.json →
          // ../../index.html) to the shell it actually serves, so the unbundled
          // sibling is found next to that shell, not the descriptor. Without
          // this, every Template/descriptor route (/sheet/{id}, /booking,
          // /settings, …) has no sibling and silently falls back to the bundle.
          let html_path = effective_html_path(&entry.path, &entry.behavior);
          if let Some(unbundled) = unbundled_html_sibling(&html_path) {
            if let Some(resp) = file_to_response(&client_req, &unbundled).await {
              return Ok(req.into_response(resp));
            }
          }
        }
      }
    }
    // Template pre-check: if this is a Template route but the handler doesn't match,
    // skip the resource group and fall through to static file serving.
    // This prevents greedy /{slug} patterns from capturing static file paths.
    let is_template_miss = {
      let file = resource_group
        .anonymous
        .as_ref()
        .or(resource_group.logged_in.as_ref());
      if let Some(file) = file {
        if let ResourceBehavior::Template { .. } = &file.behavior {
          let registry = req.app_data::<actix_web::web::Data<TemplateHandlerRegistry>>();
          match registry {
            Some(reg) => !file.template_matches(request_pattern_trimmed, reg, &req),
            None => true,
          }
        } else {
          false
        }
      } else {
        false
      }
    };

    if is_template_miss {
      // Fall through to static file serving below
    } else {
      // 1a) Identity not configured
      //
      //     Try to serve the anon resource
      //     Otherwise, serve the 404
      //
      if !uses_identity {
        if let Some(anon_file) = &resource_group.anonymous {
          return anon_file.to_response(req).await;
        }

        let resp = not_found_response(client_req, &routes, &subdomain).await;
        return Ok(req.into_response(resp));
      }

      let vc = ServiceViewerContext::extract(&req.extensions());
      if vc.auth_expired() {
        if let Some(anon_file) = &resource_group.anonymous {
          return anon_file.to_response(req).await;
        }
        return Ok(redirect_response(req, request_pattern_trimmed));
      }

      // 2a) User is logged in
      //
      //     Try to serve the logged in resource first
      //
      if vc.is_logged_in()
        && let Some(logged_in_file) = &resource_group.logged_in
      {
        if let Some(redirect) = vc.redirect() {
          // If the redirect is to the same URL, just serve the resource
          if let tento_web_files::resource_behavior::ResourceBehavior::Redirect {
            location, ..
          } = &redirect
          {
            if location == request_pattern_trimmed {
              return logged_in_file.to_response(req).await;
            }
          }
          return redirect.to_response(req, &logged_in_file.path).await;
        }
        return logged_in_file.to_response(req).await;
      }

      // 2b) User is logged out
      //
      //     Try to serve the logged out resource first
      //     Otherwise, ask the user to log in
      //
      if let Some(anon_file) = &resource_group.anonymous {
        return anon_file.to_response(req).await;
      }

      return Ok(redirect_response(req, request_pattern_trimmed));
    } // end !is_template_miss
  };

  // 3a) Serve static file if possible
  //
  let Ok(request_file_path) = routes.find_static_file(&subdomain, request_pattern_trimmed) else {
    // `find_static_file` does no IO — its only failure mode is `parse_path`
    // rejecting the pattern (e.g. dot-prefixed segments like `/.env` or
    // `/.well-known/*`). That's a request for something we can't serve, not a
    // server error: return the same clean 404 (+ `404.html` body) a missing
    // file takes, rather than a 500.
    let resp = not_found_response(&client_req, &routes, &subdomain).await;
    return Ok(req.into_response(resp));
  };

  if request_file_path.is_dir() {
    return Ok(req.into_response(HttpResponse::NotFound().finish()));
  }

  if let Some(resp) = file_to_response(&client_req, request_file_path).await {
    return Ok(req.into_response(resp));
  }

  // 3b) Serve 404
  //
  let resp = not_found_response(&client_req, &routes, &subdomain).await;
  Ok(req.into_response(resp))
}

impl FileRoutesService {
  fn routes(&mut self, mode: &DevMode) -> &DomainedRoutes {
    let state = match mode {
      DevMode::ReleaseCandidate => &mut self.state.rc_state,
      DevMode::Beta => &mut self.state.beta_state,
      DevMode::Prod => &mut self.state.prod_state,
    };
    state.routes()
  }
}

/// The actual HTML shell an entry serves. A relative `File` descriptor (e.g.
/// `sheet/{id}/index.json` whose body is `{"File":{"path":"../../index.html"}}`)
/// is followed to its target — mirroring how [`ResourceBehavior::File`] resolves
/// at serve time — so the unbundled sibling is looked up next to the shared
/// shell, not the descriptor. Non-relative or non-`File` entries serve their own
/// path unchanged.
fn effective_html_path(entry_path: &Path, behavior: &ResourceBehavior) -> PathBuf {
  if let ResourceBehavior::File {
    path,
    is_relative: true,
  } = behavior
    && let Some(parent) = entry_path.parent()
    && let Ok(resolved) = parent.join(path).canonicalize()
  {
    return resolved;
  }
  entry_path.to_path_buf()
}

/// Map a route entry's resource path to its `…/<stem>.unbundled.html` sibling, if
/// that file exists (else callers fall back to the bundled entry). The entry may
/// be the HTML itself (`index.anon.html`) or a JSON descriptor whose Template
/// renders that HTML (`index.anon.json`) — both share the `<stem>` (`index.anon`).
fn unbundled_html_sibling(entry: &Path) -> Option<PathBuf> {
  let s = entry.to_str()?;
  let stem = s
    .strip_suffix(".html")
    .or_else(|| s.strip_suffix(".json"))?;
  let candidate = PathBuf::from(format!("{stem}.unbundled.html"));
  candidate.exists().then_some(candidate)
}

/// Does a build overwrite this path, keeping its name? Those are the files a
/// cached copy can be WRONG about; everything else either never changes or
/// changes its URL when it does.
///
/// Stylesheets count: a route's own sheet (`/tsh-site.css`) is copied over on
/// every build under the same name. Measured 2026-10-19 on dev--tsh: a reload
/// ran the new `.root.js` against the stylesheet from before the change,
/// because the sheet carried no Cache-Control and Chrome reused it on
/// heuristic freshness without asking.
fn is_built_in_place(path: &str) -> bool {
  path.ends_with(".root.js")
    || path.ends_with(".root.js.map")
    || path.ends_with(".html")
    || path.ends_with(".css")
}

/// An HTML DOCUMENT carries the server's routing decisions (auth gates,
/// onboarding redirects) in the bytes it returns, so a heuristically cached
/// copy silently replays a STALE decision. Route entries served through
/// `ResourceBehavior::File` never reach [`file_to_response`], so they skipped
/// the `is_built_in_place` `.html` rule below and came back with
/// ETag/Last-Modified but no Cache-Control — and Chrome then applies heuristic
/// freshness (~10% of the response's age). Measured 2026-09-06 in the
/// `onboarding/account-deletion` UX spec: after `DELETE /api/user` + a fresh
/// `POST /api/user/signin`, the next navigation to `/` was served from the
/// browser cache (server.log shows no request at all), so the server-side
/// "no product key ⇒ 302 /onboarding" gate never ran and the SPA fell through
/// to its client-side plan gate. Same class as the 2026-08-05/07 `.root.js`
/// bug.
///
/// `no-cache` is not `no-store`: the response stays cacheable and keeps its
/// ETag/Last-Modified, it is only revalidated every time, so the usual answer
/// is a cheap 304. Hashed / content-addressed assets are untouched — `/js/m/**`
/// returns before this and is never `text/html`.
fn apply_document_cache_policy<B>(resp: &mut ServiceResponse<B>) {
  let is_html = resp
    .headers()
    .get(http::header::CONTENT_TYPE)
    .and_then(|value| value.to_str().ok())
    .is_some_and(is_html_content_type);

  if is_html {
    resp.headers_mut().insert(
      http::header::CACHE_CONTROL,
      HeaderValue::from_static("no-cache"),
    );
  }
}

/// `text/html`, with or without parameters (`; charset=utf-8`).
fn is_html_content_type(content_type: &str) -> bool {
  content_type
    .split(';')
    .next()
    .is_some_and(|mime| mime.trim().eq_ignore_ascii_case("text/html"))
}

async fn file_to_response<P: AsRef<Path>>(req: &HttpRequest, path: P) -> Option<HttpResponse> {
  let p = path.as_ref();

  match NamedFile::open_async(p).await {
    Ok(named_file) => {
      let mut resp = named_file.into_response(req);
      let path_str = p.to_str().expect("");
      if path_str.ends_with(".root.js") {
        resp.headers_mut().append(
          HeaderName::from_static("source-map"),
          HeaderValue::from_str(&format!("{}.map", req.uri().to_string()))
            .expect("couldn't create header value"),
        );
      }
      // A rebuilt bundle must never lose to a cached one. With no explicit
      // directive the browser applies HEURISTIC freshness — a fraction of the
      // file's age — so a long-lived `index.root.js` is reused for hours
      // WITHOUT revalidating, and a rebuild silently has no effect. Measured
      // 2026-08-07: a restarted daemon serving a freshly built bundle kept
      // handing out the previous one until a cache-bypassing reload, and the
      // stale build was mistaken for the new one's behaviour.
      //
      // `no-cache` is not `no-store`: the response is still cached, it is just
      // revalidated every time, so the usual answer is a 304 against the ETag
      // `NamedFile` already sets and only a real change costs bytes. Limited
      // to the files a build REWRITES IN PLACE — vendored assets under
      // `/@/static/` carry a `?v=` and are content-addressed by their URL.
      if is_built_in_place(path_str) {
        resp.headers_mut().insert(
          http::header::CACHE_CONTROL,
          HeaderValue::from_static("no-cache"),
        );
      }

      Some(resp)
    }
    Err(err) => {
      if err.kind() == ErrorKind::NotFound {
        None
      } else {
        // TODO: log
        Some(HttpResponse::InternalServerError().finish())
      }
    }
  }
}

fn redirect_response(req: ServiceRequest, request_pattern_trimmed: &str) -> ServiceResponse {
  let connection_info = req.connection_info();
  let scheme = connection_info.scheme().to_string();
  let host = connection_info.host().to_string();
  drop(connection_info);

  let full_url = format!("{scheme}://{host}{request_pattern_trimmed}");
  let encoded_url = utf8_percent_encode(&full_url, NON_ALPHANUMERIC).to_string();
  let (req, _) = req.into_parts();
  return ServiceResponse::new(
    req,
    HttpResponse::TemporaryRedirect()
      .append_header((
        http::header::LOCATION,
        HeaderValue::from_str(&format!("/signin?redirect_url={encoded_url}")).expect(""),
      ))
      .finish(),
  );
}

async fn not_found_response(
  req: &HttpRequest,
  routes: &DomainedRoutes,
  subdomain: &DomainType,
) -> HttpResponse {
  let Ok(not_found_path) = routes.find_static_file(&subdomain, "404.html") else {
    return HttpResponse::NotFound().finish();
  };

  match NamedFile::open_async(not_found_path).await {
    Ok(named_file) => named_file
      .into_response(req)
      .customize()
      .with_status(StatusCode::NOT_FOUND)
      .respond_to(req)
      .map_into_boxed_body(),
    Err(err) => {
      if err.kind() == ErrorKind::NotFound {
        HttpResponse::NotFound().finish()
      } else {
        HttpResponse::InternalServerError().finish()
      }
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn response_with_content_type(content_type: &str) -> ServiceResponse {
    actix_web::test::TestRequest::default()
      .to_srv_response(HttpResponse::Ok().content_type(content_type).finish())
  }

  fn cache_control(resp: &ServiceResponse) -> Option<&str> {
    resp
      .headers()
      .get(http::header::CACHE_CONTROL)
      .and_then(|value| value.to_str().ok())
  }

  #[test]
  fn html_content_type_matches_with_and_without_parameters() {
    assert!(is_html_content_type("text/html"));
    assert!(is_html_content_type("text/html; charset=utf-8"));
    assert!(is_html_content_type("TEXT/HTML ; charset=utf-8"));
    assert!(!is_html_content_type("text/plain"));
    assert!(!is_html_content_type("application/javascript"));
    assert!(!is_html_content_type("application/xhtml+xml"));
  }

  /// The account-deletion regression: an HTML document must revalidate rather
  /// than fall to Chrome's heuristic freshness.
  #[test]
  fn html_documents_are_served_no_cache() {
    let mut resp = response_with_content_type("text/html; charset=utf-8");
    apply_document_cache_policy(&mut resp);
    assert_eq!(cache_control(&resp), Some("no-cache"));
  }

  #[test]
  fn non_html_responses_keep_their_cache_policy() {
    // Hashed/immutable assets (`/js/m/**`) must not be downgraded.
    let mut resp = actix_web::test::TestRequest::default().to_srv_response(
      HttpResponse::Ok()
        .content_type("application/javascript")
        .insert_header((
          http::header::CACHE_CONTROL,
          "public, max-age=31536000, immutable",
        ))
        .finish(),
    );
    apply_document_cache_policy(&mut resp);
    assert_eq!(
      cache_control(&resp),
      Some("public, max-age=31536000, immutable")
    );

    // A redirect (no body, no content type) is left alone.
    let mut redirect = actix_web::test::TestRequest::default()
      .to_srv_response(HttpResponse::TemporaryRedirect().finish());
    apply_document_cache_policy(&mut redirect);
    assert_eq!(cache_control(&redirect), None);
  }

  #[test]
  fn built_in_place_covers_rewritten_files_only() {
    assert!(is_built_in_place("/x/index.root.js"));
    assert!(is_built_in_place("/x/index.root.js.map"));
    assert!(is_built_in_place("/x/index.html"));
    assert!(is_built_in_place("/x/tsh-site.css"));
    assert!(!is_built_in_place("/js/m/abc123.js"));
  }
}
