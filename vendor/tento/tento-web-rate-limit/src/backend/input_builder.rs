use std::future::{Ready, ready};
use std::net::{AddrParseError, IpAddr, Ipv6Addr, SocketAddr};
use std::time::Duration;

use actix_web::ResponseError;
use actix_web::dev::ServiceRequest;
use thiserror::Error;
use tracing::warn;

use super::SimpleInput;

type CustomFn = Box<dyn Fn(&ServiceRequest) -> Result<String, actix_web::Error>>;

pub type SimpleInputFuture = Ready<Result<SimpleInput, actix_web::Error>>;

pub struct SimpleInputFunctionBuilder {
  interval: Duration,
  max_requests: u64,
  real_ip_key: bool,
  peer_ip_key: bool,
  path_key: bool,
  custom_key: Option<String>,
  custom_fn: Option<CustomFn>,
}

impl SimpleInputFunctionBuilder {
  pub fn new(interval: Duration, max_requests: u64) -> Self {
    Self {
      interval,
      max_requests,
      real_ip_key: false,
      peer_ip_key: false,
      path_key: false,
      custom_key: None,
      custom_fn: None,
    }
  }

  pub fn real_ip_key(mut self) -> Self {
    self.real_ip_key = true;
    self
  }

  pub fn peer_ip_key(mut self) -> Self {
    self.peer_ip_key = true;
    self
  }

  pub fn path_key(mut self) -> Self {
    self.path_key = true;
    self
  }

  pub fn custom_key(mut self, key: &str) -> Self {
    self.custom_key = Some(key.to_owned());
    self
  }

  pub fn custom_fn<F>(mut self, f: F) -> Self
  where
    F: Fn(&ServiceRequest) -> Result<String, actix_web::Error> + 'static,
  {
    self.custom_fn = Some(Box::new(f));
    self
  }

  pub fn build(self) -> impl Fn(&ServiceRequest) -> SimpleInputFuture + 'static {
    move |req| {
      ready((|| {
        let mut components = Vec::new();

        if let Some(custom) = &self.custom_key {
          components.push(custom.clone());
        }

        if self.real_ip_key {
          components.push(resolve_real_ip_key(req)?);
        }

        if self.peer_ip_key {
          let peer = req
            .connection_info()
            .peer_addr()
            .map(str::to_owned)
            .ok_or_else(|| Error::MissingIpAddress {
              origin: "connection_info.peer_addr",
            })?;
          components.push(ip_key(&peer, "connection_info.peer_addr")?);
        }

        if self.path_key {
          components.push(req.path().to_owned());
        }

        if let Some(f) = &self.custom_fn {
          components.push(f(req)?);
        }

        let key = components.join("-");
        Ok(SimpleInput {
          interval: self.interval,
          max_requests: self.max_requests,
          key,
        })
      })())
    }
  }
}

pub fn resolve_real_ip_key(req: &ServiceRequest) -> Result<String, actix_web::Error> {
  let info = req.connection_info();
  let mut candidates: Vec<(&'static str, &str)> = Vec::new();

  // Forwarded-IP headers (and actix's `realip_remote_addr`, which itself trusts
  // `Forwarded` / `X-Forwarded-For`) are only believable when the direct TCP
  // peer is trusted — loopback / private / Cloudflare egress. An untrusted
  // origin scanner can forge every one of these, so for an untrusted peer we
  // skip the whole chain and key straight off the peer socket address below.
  let peer_trusted = req
    .peer_addr()
    .map(|addr| crate::trusted_proxy::is_trusted_proxy(addr.ip()))
    .unwrap_or(false);

  if peer_trusted {
    if let Some(v) = req
      .headers()
      .get("CF-Connecting-IP")
      .and_then(|h| h.to_str().ok())
    {
      candidates.push(("CF-Connecting-IP", v));
    }

    if let Some(v) = req.headers().get("X-Real-IP").and_then(|h| h.to_str().ok()) {
      candidates.push(("X-Real-IP", v));
    }

    if let Some(v) = req
      .headers()
      .get("X-Forwarded-For")
      .and_then(|h| h.to_str().ok())
      .and_then(first_x_forwarded_for)
    {
      candidates.push(("X-Forwarded-For", v));
    }

    if let Some(v) = req
      .headers()
      .get("Forwarded")
      .and_then(|h| h.to_str().ok())
      .and_then(first_forwarded_for)
    {
      candidates.push(("Forwarded", v));
    }

    if let Some(v) = info.realip_remote_addr() {
      candidates.push(("connection_info.realip_remote_addr", v));
    }
  }

  if let Some(v) = info.peer_addr() {
    candidates.push(("connection_info.peer_addr", v));
  }

  for (source, raw) in candidates {
    match ip_key(raw, source) {
      Ok(key) => return Ok(key),
      Err(err) => {
        warn!(
          rate_limit_ip_parse_failed_source = source,
          rate_limit_ip_parse_failed_raw = raw,
          rate_limit_ip_parse_failed_error = %err,
          "Unable to parse candidate real IP for rate limiter"
        );
        return Err(err.into());
      }
    }
  }

  Err(
    Error::MissingIpAddress {
      origin: "no-real-ip-candidate",
    }
    .into(),
  )
}

fn first_x_forwarded_for(value: &str) -> Option<&str> {
  value
    .split(',')
    .map(str::trim)
    .find(|part| !part.is_empty())
}

fn first_forwarded_for(value: &str) -> Option<&str> {
  for forwarded_value in value.split(',') {
    for pair in forwarded_value.split(';') {
      let pair = pair.trim();
      if let Some(candidate) = pair.strip_prefix("for=") {
        let candidate = candidate.trim().trim_matches('"');
        if !candidate.is_empty() {
          return Some(candidate);
        }
      }
    }
  }
  None
}

#[derive(Debug, Error)]
enum Error {
  #[error("Unable to parse IP address '{raw}' from {origin}: {inner}")]
  InvalidIpAddress {
    origin: &'static str,
    raw: String,
    #[source]
    inner: AddrParseError,
  },
  #[error("Missing IP address for rate limiting (source: {origin})")]
  MissingIpAddress { origin: &'static str },
}

impl ResponseError for Error {
  fn status_code(&self) -> actix_web::http::StatusCode {
    actix_web::http::StatusCode::BAD_REQUEST
  }
}

fn parse_ip(raw: &str, source: &'static str) -> Result<IpAddr, Error> {
  let value = raw.trim().trim_matches('"');

  if let Ok(socket) = value.parse::<SocketAddr>() {
    return Ok(socket.ip());
  }

  if value.starts_with('[') {
    if let Some(end) = value.find(']') {
      let inside = &value[1..end];
      return inside
        .parse::<IpAddr>()
        .map_err(|inner| Error::InvalidIpAddress {
          origin: source,
          raw: raw.to_owned(),
          inner,
        });
    }
  }

  if value.contains(':') && value.contains('.') && value.matches(':').count() == 1 {
    let host = value
      .rsplit_once(':')
      .map(|(host, _)| host)
      .unwrap_or(value);
    return host
      .parse::<IpAddr>()
      .map_err(|inner| Error::InvalidIpAddress {
        origin: source,
        raw: raw.to_owned(),
        inner,
      });
  }

  let value = value.split('%').next().unwrap_or(value);
  value
    .parse::<IpAddr>()
    .map_err(|inner| Error::InvalidIpAddress {
      origin: source,
      raw: raw.to_owned(),
      inner,
    })
}

fn ip_key(ip_str: &str, source: &'static str) -> Result<String, Error> {
  let ip = parse_ip(ip_str, source)?;
  Ok(match ip {
    IpAddr::V4(v4) => v4.to_string(),
    IpAddr::V6(v6) => {
      if let Some(v4) = v6.to_ipv4() {
        return Ok(v4.to_string());
      }
      let zeroes = [0u16; 4];
      let concat = [&v6.segments()[0..4], &zeroes].concat();
      let concat: [u16; 8] = concat.try_into().expect("IPv6 segments length mismatch");
      let subnet = Ipv6Addr::from(concat);
      format!("{subnet}/64")
    }
  })
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn test_ip_key() {
    assert_eq!(
      ip_key("142.250.187.206", "test").expect("ip key"),
      "142.250.187.206"
    );
    assert_eq!(
      ip_key("::FFFF:142.250.187.206", "test").expect("mapped v4"),
      "142.250.187.206"
    );
    assert_eq!(
      ip_key("2a00:1450:4009:81f::200e", "test").expect("v6 /64"),
      "2a00:1450:4009:81f::/64"
    );
  }

  #[test]
  fn test_parse_ip_with_port() {
    assert_eq!(
      parse_ip("192.168.1.3:443", "x-real").expect("ip with port"),
      "192.168.1.3".parse::<IpAddr>().expect("parse v4")
    );
    assert_eq!(
      parse_ip("[2606:4700:4700::1111]:443", "x-real").expect("v6 with port"),
      "2606:4700:4700::1111".parse::<IpAddr>().expect("parse v6")
    );
  }

  #[test]
  fn test_forwarded_parsing() {
    let value = "for=192.168.1.10:443;proto=https;host=dev.lona.so";
    assert_eq!(first_forwarded_for(value), Some("192.168.1.10:443"));
  }

  #[test]
  fn untrusted_peer_ignores_forwarded_headers() {
    // A scanner hitting the origin directly forges CF-Connecting-IP. The peer
    // (8.8.8.8) is not trusted, so the key must fall back to the peer address.
    let req = actix_web::test::TestRequest::default()
      .peer_addr("8.8.8.8:54321".parse().expect("peer addr"))
      .insert_header(("CF-Connecting-IP", "1.2.3.4"))
      .insert_header(("X-Forwarded-For", "5.6.7.8"))
      .to_srv_request();
    assert_eq!(resolve_real_ip_key(&req).expect("key"), "8.8.8.8");
  }

  #[test]
  fn trusted_peer_honors_cf_connecting_ip() {
    // A genuine Cloudflare-proxied request: peer is a CF egress IP, so the
    // real visitor IP from CF-Connecting-IP wins.
    let req = actix_web::test::TestRequest::default()
      .peer_addr("104.16.1.1:443".parse().expect("peer addr"))
      .insert_header(("CF-Connecting-IP", "1.2.3.4"))
      .to_srv_request();
    assert_eq!(resolve_real_ip_key(&req).expect("key"), "1.2.3.4");
  }

  #[test]
  fn loopback_peer_is_trusted() {
    // Local reverse proxy / health checks: loopback peer, header honored.
    let req = actix_web::test::TestRequest::default()
      .peer_addr("127.0.0.1:1234".parse().expect("peer addr"))
      .insert_header(("CF-Connecting-IP", "9.9.9.9"))
      .to_srv_request();
    assert_eq!(resolve_real_ip_key(&req).expect("key"), "9.9.9.9");
  }
}
