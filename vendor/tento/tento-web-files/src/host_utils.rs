use actix_http::{RequestHead, Uri, header};

pub fn get_host_uri(req: &RequestHead) -> Option<Uri> {
  req
    .headers
    .get(header::HOST)
    .and_then(|host_value| host_value.to_str().ok())
    .or_else(|| req.uri.host())
    .and_then(|host| host.parse().ok())
}
