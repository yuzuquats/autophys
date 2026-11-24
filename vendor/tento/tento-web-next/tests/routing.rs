use std::sync::Arc;

use futures_util::StreamExt;
use tento_web_next::{
  Body, BuildState, DomainConfig, HttpRequest, HttpResponse, HttpResponseBuilder, Router, Webapp,
  http::{Request, StatusCode, header},
  routes, web,
};

fn allowed(req: &HttpRequest) -> bool {
  req.headers().get("x-test-access").is_some()
}

#[derive(Router)]
#[router {
    "/child" { "/version" { get: version } }
}]
struct Child;

#[derive(Router)]
#[router {
    "/private" {
        [guard = allowed] { mount Child } else { redirect("/signin") }
    }
}]
struct Api;

#[tento_web_next::api(responses((status = 200)))]
async fn version() -> &'static str {
  "version"
}

async fn detail(
  path: web::Path<(String, String)>,
  data: web::Data<&'static str>,
  req: HttpRequest,
) -> HttpResponse {
  let (first, second) = path.into_inner();
  HttpResponseBuilder::new(StatusCode::OK).json(serde_json::json!({
      "first": first,
      "second": second,
      "scope": *data.get_ref(),
      "query": req.query_string(),
  }))
}

#[derive(serde::Deserialize)]
struct TypedPath {
  id: u64,
  enabled: bool,
}

async fn numeric_id(id: web::Path<u64>) -> HttpResponse {
  HttpResponse::Ok().json(id.into_inner())
}

async fn numeric_tuple(path: web::Path<(u64, bool)>) -> HttpResponse {
  HttpResponse::Ok().json(path.into_inner())
}

async fn numeric_named(path: web::Path<TypedPath>) -> HttpResponse {
  HttpResponse::Ok().json((path.id, path.enabled))
}

#[cfg(feature = "axum")]
async fn open_event_stream() -> HttpResponse {
  let initial = futures_util::stream::iter([Ok(web::Bytes::from_static(b"data: connected\n\n"))]);
  let pending = futures_util::stream::pending();
  HttpResponse::Ok()
    .content_type("text/event-stream; charset=utf-8")
    .streaming(Body::stream(initial.chain(pending)))
}

async fn echo(body: web::Bytes) -> HttpResponse {
  HttpResponseBuilder::new(StatusCode::OK).body(body)
}

async fn missing() -> HttpResponse {
  HttpResponseBuilder::new(StatusCode::NOT_FOUND).body("api miss")
}

async fn events(req: HttpRequest) -> HttpResponse {
  #[cfg(any(feature = "actix", feature = "axum", feature = "ntex"))]
  if req
    .extensions()
    .get::<tento_web_next::backend::PeerAddress>()
    .is_none()
  {
    return HttpResponseBuilder::new(StatusCode::INTERNAL_SERVER_ERROR).finish();
  }
  let _ = req;
  let records = futures_util::stream::iter([
    Ok(web::Bytes::from_static(b"data: first\n\n")),
    Ok(web::Bytes::from_static(b"data: second\n\n")),
  ]);
  HttpResponseBuilder::new(StatusCode::OK)
    .header(header::CONTENT_TYPE, "text/event-stream".parse().unwrap())
    .header(header::SET_COOKIE, "session=one; Path=/".parse().unwrap())
    .header(
      header::SET_COOKIE,
      "session=; Path=/api; Max-Age=0".parse().unwrap(),
    )
    .streaming(Body::stream(records))
}

fn fixture() -> (tempfile::TempDir, Arc<Webapp>) {
  let temp = tempfile::tempdir().unwrap();
  for (relative, contents) in [
    ("routes/index.anon.html", "autophys shell"),
    ("routes/index.root.js", "autophys entry"),
    ("routes/studies/{id}/index.anon.html", "study"),
    ("routes/studies/about/index.anon.html", "about"),
    (
      "routes/api/unmatched/index.anon.html",
      "not an API response",
    ),
    ("routes/404.html", "missing document"),
    ("modules/js/m/hash.js", "shared module"),
  ] {
    let path = temp.path().join(relative);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, contents).unwrap();
  }
  let domain = DomainConfig::builder()
    .hostname("localhost")
    .config(|cfg| {
      cfg.service(Api::service());
      cfg.route("/numeric/{id}", web::get().to(numeric_id));
      cfg.route("/tuple/{id}/{enabled}", web::get().to(numeric_tuple));
      cfg.route("/named/{id}/{enabled}", web::get().to(numeric_named));
      #[cfg(feature = "axum")]
      cfg.route("/shutdown-events", web::get().to(open_event_stream));

      cfg.service(
        web::scope("/api")
          .app_data(web::Data::new("api"))
          .app_data(web::PayloadConfig::new(10))
          .service(routes! { "/items" { "/{first}/{second}" { get: detail } } })
          .route("/echo", web::post().to(echo))
          .route("/events", web::get().to(events))
          .default_service(web::to(missing)),
      );
    })
    .build();
  let state =
    BuildState::single_stage(temp.path().to_owned()).with_module_store(temp.path().join("modules"));
  let app = Webapp::prebuilt(&domain, state).unwrap();
  (temp, Arc::new(app))
}

async fn text(response: HttpResponse) -> String {
  let mut stream = response.into_body().into_stream();
  let mut bytes = Vec::new();
  while let Some(chunk) = stream.next().await {
    bytes.extend_from_slice(&chunk.unwrap());
  }
  String::from_utf8(bytes).unwrap()
}

#[tokio::test]
async fn macros_and_files_share_one_application() {
  let (_temp, app) = fixture();
  let call = |method, uri| {
    app.call(
      Request::builder()
        .method(method)
        .uri(uri)
        .body(Body::empty())
        .unwrap(),
    )
  };

  let response = call("GET", "/api/items/a%20b/second?offset=2").await;
  assert_eq!(response.status(), StatusCode::OK);
  assert_eq!(
    serde_json::from_str::<serde_json::Value>(&text(response).await).unwrap(),
    serde_json::json!({
        "first": "a b", "second": "second", "scope": "api", "query": "offset=2",
    })
  );
  let response = call("GET", "/private/child/version").await;
  assert_eq!(response.status(), StatusCode::FOUND);
  assert_eq!(response.headers()[header::LOCATION], "/signin");
  let response = app
    .call(
      Request::builder()
        .method("HEAD")
        .uri("/private/child/version")
        .header("x-test-access", "yes")
        .body(Body::empty())
        .unwrap(),
    )
    .await;
  assert_eq!(response.status(), StatusCode::OK);
  assert_eq!(text(response).await, "");
  let document = serde_json::to_value(Api::apidoc()).unwrap();
  assert!(document["paths"]["/private/child/version"]["get"].is_object());

  for (uri, expected) in [
    ("/", "autophys shell"),
    ("/studies/some-id/", "study"),
    ("/studies/about", "about"),
    ("/index.root.js", "autophys entry"),
    ("/js/m/hash.js", "shared module"),
    ("/api/unmatched", "api miss"),
    ("/missing", "missing document"),
  ] {
    assert_eq!(text(call("GET", uri).await).await, expected, "{uri}");
  }

  let response = call("HEAD", "/index.root.js").await;
  assert_eq!(response.headers()[header::CONTENT_LENGTH], "14");
  assert_eq!(text(response).await, "");
  let response = app
    .call(
      Request::builder()
        .method("POST")
        .uri("/api/echo")
        .body(Body::bytes("exceeds ten bytes"))
        .unwrap(),
    )
    .await;
  assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
}

#[tokio::test]
async fn path_extracts_scalar_tuple_and_named_values() {
  let (_temp, app) = fixture();
  for (path, expected) in [
    ("/numeric/42", "42"),
    ("/tuple/42/true", "[42,true]"),
    ("/named/42/true", "[42,true]"),
  ] {
    let response = app
      .call(Request::builder().uri(path).body(Body::empty()).unwrap())
      .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(text(response).await, expected);
  }
  let invalid = app
    .call(
      Request::builder()
        .uri("/numeric/18446744073709551616")
        .body(Body::empty())
        .unwrap(),
    )
    .await;
  assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn mutable_assets_revalidate_with_etag_precedence() {
  let (temp, app) = fixture();
  let call = |uri, headers: Option<(&str, &str)>| {
    let mut request = Request::builder().uri(uri);
    if let Some((etag, modified)) = headers {
      request = request
        .header(header::IF_NONE_MATCH, etag)
        .header(header::IF_MODIFIED_SINCE, modified);
    }
    app.call(request.body(Body::empty()).unwrap())
  };
  let first = call("/index.root.js", None).await;
  assert_eq!(first.headers()[header::CACHE_CONTROL], "no-cache");
  let tag = first.headers()[header::ETAG].to_str().unwrap().to_owned();
  let date = first.headers()[header::LAST_MODIFIED]
    .to_str()
    .unwrap()
    .to_owned();
  let conditional = format!(r#""not,it", {}"#, tag.trim_start_matches("W/"));
  let cached = call("/index.root.js", Some((&conditional, &date))).await;
  assert_eq!(cached.status(), StatusCode::NOT_MODIFIED);
  assert_eq!(cached.headers()[header::CACHE_CONTROL], "no-cache");
  assert_eq!(cached.headers()[header::ETAG], tag.as_str());
  assert_eq!(text(cached).await, "");

  let replaced = temp.path().join("routes/replacement");
  std::fs::write(&replaced, "updated bundle").unwrap();
  let when = std::fs::metadata(temp.path().join("routes/index.root.js"))
    .unwrap()
    .modified()
    .unwrap();
  std::fs::File::options()
    .write(true)
    .open(&replaced)
    .unwrap()
    .set_times(std::fs::FileTimes::new().set_modified(when))
    .unwrap();
  std::fs::rename(replaced, temp.path().join("routes/index.root.js")).unwrap();
  let updated = call("/index.root.js", Some((&tag, &date))).await;
  assert_eq!(updated.status(), StatusCode::OK);
  assert_ne!(updated.headers()[header::ETAG], tag.as_str());
  assert_eq!(text(updated).await, "updated bundle");

  let module = call("/js/m/hash.js", None).await;
  assert_eq!(
    module.headers()[header::CACHE_CONTROL],
    "public, max-age=31536000, immutable"
  );
}

#[cfg(feature = "axum")]
#[tokio::test]
async fn axum_shutdown_closes_an_open_event_stream() {
  use std::{net::TcpListener, time::Duration};
  use tento_web_next::{TentoWebServer, backend::Backend};
  use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    sync::oneshot,
    time::timeout,
  };

  let (_temp, app) = fixture();
  let listener = TcpListener::bind("127.0.0.1:0").unwrap();
  let address = listener.local_addr().unwrap();
  let (stop, stopped) = oneshot::channel();
  let server = tokio::spawn(
    TentoWebServer::new(app, Backend::Axum).serve(listener, async move {
      let _ = stopped.await;
    }),
  );
  let mut client = TcpStream::connect(address).await.unwrap();
  client
    .write_all(b"GET /shutdown-events HTTP/1.1\r\nHost: localhost\r\n\r\n")
    .await
    .unwrap();
  let mut response = Vec::new();
  timeout(Duration::from_secs(2), async {
    let mut chunk = [0_u8; 1024];
    while !response
      .windows(b"data: connected".len())
      .any(|part| part == b"data: connected")
    {
      let size = client.read(&mut chunk).await.unwrap();
      assert!(
        size > 0,
        "event stream closed before sending its first event"
      );
      response.extend_from_slice(&chunk[..size]);
    }
  })
  .await
  .unwrap();

  stop.send(()).unwrap();
  timeout(Duration::from_secs(2), server)
    .await
    .unwrap()
    .unwrap()
    .unwrap();
  timeout(Duration::from_secs(2), client.read_to_end(&mut response))
    .await
    .unwrap()
    .unwrap();
}

#[cfg(any(feature = "actix", feature = "axum", feature = "ntex"))]
async fn listener_contract(backend: tento_web_next::backend::Backend) {
  use std::{net::TcpListener, time::Duration};
  use tento_web_next::TentoWebServer;
  use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    sync::oneshot,
    time::timeout,
  };

  let (_temp, app) = fixture();
  let listener = TcpListener::bind("127.0.0.1:0").unwrap();
  let address = listener.local_addr().unwrap();
  let (stop, stopped) = oneshot::channel();
  let server = tokio::spawn(
    TentoWebServer::new(app, backend).serve(listener, async move {
      let _ = stopped.await;
    }),
  );
  let request = |wire: &'static str| async move {
    timeout(Duration::from_secs(10), async move {
      let mut client = TcpStream::connect(address).await.unwrap();
      client.write_all(wire.as_bytes()).await.unwrap();
      let mut response = String::new();
      client.read_to_string(&mut response).await.unwrap();
      response
    })
    .await
    .unwrap()
  };

  let shell =
    request("GET /studies/alpha HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n").await;
  assert!(shell.starts_with("HTTP/1.1 200 "), "{shell}");
  assert!(shell.ends_with("study"), "{shell}");

  let route =
    request("GET /api/items/alpha/beta HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
      .await;
  assert!(route.starts_with("HTTP/1.1 200 "), "{route}");
  assert!(route.contains(r#""first":"alpha""#), "{route}");
  assert!(route.contains(r#""second":"beta""#), "{route}");

  let echo = request("POST /api/echo HTTP/1.1\r\nHost: localhost\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello").await;
  assert!(echo.starts_with("HTTP/1.1 200 "), "{echo}");
  assert!(echo.contains("hello"), "{echo}");

  let head =
    request("HEAD /index.root.js HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n").await;
  assert!(head.starts_with("HTTP/1.1 200 "), "{head}");
  assert!(
    head.to_ascii_lowercase().contains("content-length: 14"),
    "{head}"
  );
  assert!(head.ends_with("\r\n\r\n"), "{head}");

  let cached = request(
    "GET /index.root.js HTTP/1.1\r\nHost: localhost\r\nIf-None-Match: *\r\nConnection: close\r\n\r\n"
  ).await;
  assert!(cached.starts_with("HTTP/1.1 304 "), "{cached}");
  assert!(
    cached
      .to_ascii_lowercase()
      .contains("cache-control: no-cache"),
    "{cached}"
  );
  assert_eq!(cached.split_once("\r\n\r\n").unwrap().1, "", "{cached}");

  let stream =
    request("GET /api/events HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n").await;
  assert!(stream.starts_with("HTTP/1.1 200 "), "{stream}");
  assert!(
    stream.contains("data: first") && stream.contains("data: second"),
    "{stream}"
  );
  assert_eq!(
    stream.to_ascii_lowercase().matches("set-cookie:").count(),
    2,
    "{stream}"
  );

  stop.send(()).unwrap();
  timeout(Duration::from_secs(12), server)
    .await
    .unwrap()
    .unwrap()
    .unwrap();
}

#[cfg(feature = "actix")]
#[tokio::test]
async fn actix_listener() {
  listener_contract(tento_web_next::backend::Backend::Actix).await;
}

#[cfg(feature = "axum")]
#[tokio::test]
async fn axum_listener() {
  listener_contract(tento_web_next::backend::Backend::Axum).await;
}

#[cfg(feature = "ntex")]
#[tokio::test]
async fn ntex_listener() {
  listener_contract(tento_web_next::backend::Backend::Ntex).await;
}
