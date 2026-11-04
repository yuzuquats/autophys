use actix_web::{HttpServer, cookie::Key, web};
use tento_web::LonaServerConfig;

#[actix_web::main]
async fn main() -> Result<(), std::io::Error> {
  let log_path = std::path::Path::new("/home/yuzu-rs-logs.ljson");
  let secret_key = Key::generate();

  let lona = LonaServerConfig::new(log_path, secret_key, CookieSessionStore::default());

  HttpServer::new(move || {
    lona
      .clone()
      .spawn()
      .route("/", web::to(|| async { "hello" }))
  })
  .bind("0.0.0.0:8081")?
  .run()
  .await?;

  Ok(())
}

//
// Test
//
// .service(web::resource("test").route(web::get().to(test)))

// async fn test() -> Result<impl Responder, std::io::Error> {
//   info_span!("outer", hello = "wo\nld").in_scope(|| {
//     info_span!("inner").in_scope(|| {
//       debug_span!("inner inner");
//     })
//   });
//   Ok(HttpResponse::Ok())
// }

// .route(
//   "/malformed-json",
//   web::to(|body: web::Json<JsonPayload>| async {
//     info!("whoa body: {:#?}", body.into_inner());
//     "hello"
//   }),
// )
// #[derive(Deserialize, Debug)]
// struct JsonPayload {
//   #[allow(dead_code)]
//   name: String,
// }
