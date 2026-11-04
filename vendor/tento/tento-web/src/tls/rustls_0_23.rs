use anyhow::{Context, anyhow};
use rustls::{
  ServerConfig,
  client::verify_server_name,
  crypto::aws_lc_rs::sign::any_supported_type,
  pki_types::{CertificateDer, DnsName, PrivateKeyDer, ServerName},
  server::{ClientHello, ParsedCertificate},
  sign::SigningKey,
};
use std::{collections::HashMap, fs::File, io::BufReader, sync::Arc};
use tento_core::result::ResultsExt;

use crate::utils::root_domain;

use super::SslMap;

pub fn rust_tls_0_23(sslmap: &SslMap) -> anyhow::Result<rustls::ServerConfig> {
  let mut cert_resolver = SniResolver::new();
  for (domain_name, config) in sslmap {
    let (cert, key) = load_certificates_and_keys(
      config
        .cert_path
        .to_str()
        .ok_or(anyhow!("cert path not stringable"))?,
      config
        .pkey_path
        .to_str()
        .ok_or(anyhow!("pkey path not stringable"))?,
      config
        .ca_bundle_path
        .as_ref()
        .map(|ca_bundle| ca_bundle.to_str())
        .flatten(),
    )?;
    let key: Arc<dyn SigningKey> =
      any_supported_type(&key).context("signing key (.pem) is not one of the supported types")?;
    cert_resolver.add(&domain_name, rustls::sign::CertifiedKey::new(cert, key))?;
  }

  let provider = rustls::crypto::aws_lc_rs::default_provider();
  let config = ServerConfig::builder_with_provider(Arc::new(provider))
    .with_safe_default_protocol_versions()?
    .with_no_client_auth()
    .with_cert_resolver(Arc::new(cert_resolver));

  Ok(config)
}

fn load_certificates_and_keys(
  cert_path: &str,
  key_path: &str,
  bundle_path: Option<&str>,
) -> anyhow::Result<(Vec<CertificateDer<'static>>, PrivateKeyDer<'static>)> {
  let cert_file = &mut BufReader::new(File::open(cert_path)?);
  let mut cert_chain = rustls_pemfile::certs(cert_file)
    .collect::<Vec<_>>()
    .full_res()
    .map_err(|_| anyhow!("couldn't read cert files"))?;

  // Append intermediates from bundle (if provided)
  if let Some(p) = bundle_path {
    let bundle_file = &mut BufReader::new(File::open(p)?);
    let mut intermediates = rustls_pemfile::certs(bundle_file)
      .collect::<Vec<_>>()
      .full_res()
      .map_err(|_| anyhow!("couldn't read key files"))?;
    cert_chain.append(&mut intermediates);
  }

  // Read any supported private key (PKCS#8, PKCS#1 RSA, or SEC1 EC)
  let key_file = &mut BufReader::new(File::open(key_path)?);
  let key = match rustls_pemfile::private_key(key_file)? {
    Some(k) => k, // This returns pki_types::PrivateKeyDer<'static>
    None => anyhow::bail!("no private key found in {}", key_path),
  };

  Ok((cert_chain, key))
}

///
///
/// Forked from rustls::server::ResolvesServerCertUsingSni
///
///
#[derive(Debug)]
pub struct SniResolver {
  by_name: HashMap<String, Arc<rustls::sign::CertifiedKey>>,
}

impl SniResolver {
  pub fn new() -> Self {
    Self {
      by_name: HashMap::new(),
    }
  }

  pub fn add(&mut self, name: &str, ck: rustls::sign::CertifiedKey) -> anyhow::Result<()> {
    let server_name = {
      let checked_name = DnsName::try_from(name)
        .context("Bad SNI name")
        .map(|name| name.to_lowercase_owned())?;
      ServerName::DnsName(checked_name)
    };

    ck.end_entity_cert()
      .and_then(ParsedCertificate::try_from)
      .and_then(|cert| verify_server_name(&cert, &server_name))?;

    if let ServerName::DnsName(name) = server_name {
      self.by_name.insert(name.as_ref().to_string(), Arc::new(ck));
    }
    Ok(())
  }
}

impl rustls::server::ResolvesServerCert for SniResolver {
  fn resolve(&self, client_hello: ClientHello<'_>) -> Option<Arc<rustls::sign::CertifiedKey>> {
    let Some(name) = client_hello.server_name() else {
      return None;
    };
    let host_name_base = root_domain(name);
    self.by_name.get(host_name_base).cloned()
  }
}
