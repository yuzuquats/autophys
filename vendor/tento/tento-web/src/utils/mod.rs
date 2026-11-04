use actix_web::HttpResponse;

pub mod patch;
pub mod prefixed_uuid;

pub fn html(s: &str) -> HttpResponse {
  HttpResponse::Ok()
    .content_type("text/html; charset=utf-8")
    .body(s.to_owned())
}

pub fn js(s: &str) -> HttpResponse {
  HttpResponse::Ok()
    .content_type("text/javascript; charset=utf-8")
    .body(s.to_owned())
}

// Converts
//   "calendar.lona.so"
//     to
//   "lona.so"
// If the host_name is too short, just returns it instead.
//   "blah"
//     to
//   "blah"
//
pub fn root_domain(host_name: &str) -> &str {
  let parts = host_name.split(".").collect::<Vec<&str>>();
  if parts.len() >= 2 {
    // Compute the start index of the second-to-last component in the original string
    //
    let start_index = parts
      .iter()
      .take(parts.len() - 2) // Consider all but the last part
      .map(|&part| part.len() + 1) // +1 for the dot after each part
      .sum();
    &host_name[start_index..]
  } else {
    host_name
  }
}
