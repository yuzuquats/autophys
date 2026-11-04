use crate::domain::SslConfig;

pub mod rustls_0_23;
pub mod ssl;

/**
 * Check SSL status here: https://www.ssllabs.com/ssltest/analyze.html
 */
pub type SslMap = fnv::FnvHashMap<String, SslConfig>;

pub fn rustls_config(sslmap: &SslMap) -> anyhow::Result<::rustls::ServerConfig> {
  crate::tls::rustls_0_23::rust_tls_0_23(sslmap)
}

// #[allow(dead_code)]
// pub fn ssl_config(sslmap: &SslMap) -> openssl::ssl::SslAcceptorBuilder {
//   crate::tls::ssl::ssl_config(sslmap)
// }
