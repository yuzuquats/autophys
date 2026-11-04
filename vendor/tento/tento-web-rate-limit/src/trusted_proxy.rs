//! Trust gate for forwarded-IP headers.
//!
//! Prod topology: the app terminates TLS on `0.0.0.0:8443` itself. The only
//! legitimate front is Cloudflare, so genuine proxied requests arrive FROM a
//! Cloudflare egress IP carrying `CF-Connecting-IP` / `X-Forwarded-For`.
//! Scanners hit the origin directly and can forge those headers. We therefore
//! honor forwarded-IP headers ONLY when the peer socket address is itself
//! trusted (loopback, RFC1918/ULA private, or a Cloudflare egress range).
//!
//! NOTE: this module is duplicated verbatim in
//! `tento-logger/src/trusted_proxy.rs`. `tento-web-rate-limit` deliberately has
//! zero tento-crate dependencies and `tento-logger` is a heavy foundational
//! crate; neither depends on the other, so there is no shared crate to host a
//! single copy without dragging a large dependency tree in the wrong direction.
//! If you edit the Cloudflare list here, edit the other copy too.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

/// Cloudflare published IPv4 egress ranges. Keep in sync with
/// <https://www.cloudflare.com/ips/>.
const CLOUDFLARE_V4: &[(Ipv4Addr, u8)] = &[
  (Ipv4Addr::new(173, 245, 48, 0), 20),
  (Ipv4Addr::new(103, 21, 244, 0), 22),
  (Ipv4Addr::new(103, 22, 200, 0), 22),
  (Ipv4Addr::new(103, 31, 4, 0), 22),
  (Ipv4Addr::new(141, 101, 64, 0), 18),
  (Ipv4Addr::new(108, 162, 192, 0), 18),
  (Ipv4Addr::new(190, 93, 240, 0), 20),
  (Ipv4Addr::new(188, 114, 96, 0), 20),
  (Ipv4Addr::new(197, 234, 240, 0), 22),
  (Ipv4Addr::new(198, 41, 128, 0), 17),
  (Ipv4Addr::new(162, 158, 0, 0), 15),
  (Ipv4Addr::new(104, 16, 0, 0), 13),
  (Ipv4Addr::new(104, 24, 0, 0), 14),
  (Ipv4Addr::new(172, 64, 0, 0), 13),
  (Ipv4Addr::new(131, 0, 72, 0), 22),
];

/// Cloudflare published IPv6 egress ranges. Keep in sync with
/// <https://www.cloudflare.com/ips/>.
const CLOUDFLARE_V6: &[(Ipv6Addr, u8)] = &[
  (Ipv6Addr::new(0x2400, 0xcb00, 0, 0, 0, 0, 0, 0), 32),
  (Ipv6Addr::new(0x2606, 0x4700, 0, 0, 0, 0, 0, 0), 32),
  (Ipv6Addr::new(0x2803, 0xf800, 0, 0, 0, 0, 0, 0), 32),
  (Ipv6Addr::new(0x2405, 0xb500, 0, 0, 0, 0, 0, 0), 32),
  (Ipv6Addr::new(0x2405, 0x8100, 0, 0, 0, 0, 0, 0), 32),
  (Ipv6Addr::new(0x2a06, 0x98c0, 0, 0, 0, 0, 0, 0), 29),
  (Ipv6Addr::new(0x2c0f, 0xf248, 0, 0, 0, 0, 0, 0), 32),
];

fn v4_in_cidr(addr: Ipv4Addr, net: Ipv4Addr, prefix: u8) -> bool {
  if prefix == 0 {
    return true;
  }
  let mask: u32 = u32::MAX << (32 - prefix as u32);
  (u32::from(addr) & mask) == (u32::from(net) & mask)
}

fn v6_in_cidr(addr: Ipv6Addr, net: Ipv6Addr, prefix: u8) -> bool {
  if prefix == 0 {
    return true;
  }
  let mask: u128 = u128::MAX << (128 - prefix as u32);
  (u128::from(addr) & mask) == (u128::from(net) & mask)
}

/// Whether `peer` (the direct TCP peer socket address) is allowed to set
/// forwarded-IP headers we will believe: loopback, RFC1918/ULA private, or a
/// Cloudflare egress range.
pub fn is_trusted_proxy(peer: IpAddr) -> bool {
  match peer {
    IpAddr::V4(v4) => {
      v4.is_loopback()
        || v4.is_private()
        || CLOUDFLARE_V4
          .iter()
          .any(|&(net, prefix)| v4_in_cidr(v4, net, prefix))
    }
    IpAddr::V6(v6) => {
      // IPv4-mapped IPv6 peers (`::ffff:a.b.c.d`) — dual-stack sockets deliver
      // real IPv4 clients this way; re-check the embedded v4.
      if let Some(v4) = v6.to_ipv4_mapped() {
        return is_trusted_proxy(IpAddr::V4(v4));
      }
      // fc00::/7 unique-local (ULA) private range.
      let ula_private = (v6.segments()[0] & 0xfe00) == 0xfc00;
      v6.is_loopback()
        || ula_private
        || CLOUDFLARE_V6
          .iter()
          .any(|&(net, prefix)| v6_in_cidr(v6, net, prefix))
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn ip(s: &str) -> IpAddr {
    s.parse().expect("parse ip")
  }

  #[test]
  fn loopback_trusted() {
    assert!(is_trusted_proxy(ip("127.0.0.1")));
    assert!(is_trusted_proxy(ip("::1")));
  }

  #[test]
  fn private_trusted() {
    assert!(is_trusted_proxy(ip("10.0.0.5")));
    assert!(is_trusted_proxy(ip("172.16.9.9")));
    assert!(is_trusted_proxy(ip("192.168.1.1")));
    assert!(is_trusted_proxy(ip("fd00::1"))); // ULA
  }

  #[test]
  fn cloudflare_trusted() {
    assert!(is_trusted_proxy(ip("104.16.1.1"))); // 104.16.0.0/13
    assert!(is_trusted_proxy(ip("173.245.48.1"))); // 173.245.48.0/20
    assert!(is_trusted_proxy(ip("2606:4700::1"))); // 2606:4700::/32
  }

  #[test]
  fn public_untrusted() {
    assert!(!is_trusted_proxy(ip("8.8.8.8")));
    assert!(!is_trusted_proxy(ip("1.1.1.1"))); // CF anycast resolver, not egress
    assert!(!is_trusted_proxy(ip("2001:4860:4860::8888")));
  }

  #[test]
  fn mapped_v4_follows_v4_rules() {
    assert!(is_trusted_proxy(ip("::ffff:127.0.0.1")));
    assert!(is_trusted_proxy(ip("::ffff:10.0.0.1")));
    assert!(!is_trusted_proxy(ip("::ffff:8.8.8.8")));
  }

  #[test]
  fn cidr_boundaries() {
    // 104.16.0.0/13 spans 104.16.0.0 – 104.23.255.255; 104.24.0.0/14 spans
    // 104.24 – 104.27. 104.28.x is outside every CF block.
    assert!(is_trusted_proxy(ip("104.23.255.255")));
    assert!(is_trusted_proxy(ip("104.24.0.1")));
    assert!(!is_trusted_proxy(ip("104.28.0.1")));
    // 131.0.72.0/22 — just below is untrusted
    assert!(!is_trusted_proxy(ip("131.0.71.255")));
    assert!(is_trusted_proxy(ip("131.0.75.255")));
  }
}
