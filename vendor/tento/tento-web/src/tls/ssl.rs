// use openssl::ssl::{NameType, SslAcceptor, SslAcceptorBuilder, SslFiletype, SslMethod};

// use crate::utils::root_domain;

// use super::SslMap;

// pub fn ssl_config(sslmap: &SslMap) -> SslAcceptorBuilder {
//   let map = sslmap.clone();
//   let mut acceptor =
//     SslAcceptor::mozilla_intermediate(SslMethod::tls()).expect("couldn't create ssl builder");
//   acceptor.set_servername_callback(move |sslref, _| {
//     let Some(host_name) = sslref.servername(NameType::HOST_NAME) else {
//       return Ok(());
//     };

//     let host_name_base = root_domain(host_name);
//     if let Some(ssl) = map.get(host_name_base) {
//       sslref
//         .set_private_key_file(ssl.pkey_path.as_path(), SslFiletype::PEM)
//         .expect("couldn't set pkey file");
//       sslref
//         .set_certificate_chain_file(ssl.cert_path.as_path())
//         .expect("couldn't set cert chain file");
//     }
//     return Ok(());
//   });
//   acceptor
// }
