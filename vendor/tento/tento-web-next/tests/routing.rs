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
