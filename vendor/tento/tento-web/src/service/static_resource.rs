use std::{fs, path::PathBuf};

use actix::fut::{Ready, ready};
use actix_web::FromRequest;
use tento_env::env_kv;

use crate::DevMode;

env_kv!("RELEASES_DIR", PathBuf);
env_kv!("SECRETS_ROOT", PathBuf);

#[derive(Clone)]
pub struct StaticResource {
  dev_mode: DevMode,
}

impl FromRequest for StaticResource {
  type Error = actix_web::Error;

  type Future = Ready<Result<Self, Self::Error>>;

  fn from_request(req: &actix_web::HttpRequest, _: &mut actix_http::Payload) -> Self::Future {
    ready(Ok(StaticResource {
      dev_mode: DevMode::extract_from_request(req),
    }))
  }
}

impl StaticResource {
  pub fn read_to_string(
    &self,
    rdir: &ReleasesDir,
    domain: &str,
    path: &str,
  ) -> anyhow::Result<String> {
    let mut p = rdir.0.clone();
    p.push(match self.dev_mode {
      DevMode::Beta => "target.web.beta",
      DevMode::ReleaseCandidate => "target.web.rc",
      DevMode::Prod => "target.web",
    });
    p.push(domain);
    p.push(path);
    Ok(fs::read_to_string(p)?)
  }

  pub fn path(&self, rdir: &ReleasesDir, domain: &str, path: &str) -> PathBuf {
    let mut p = rdir.0.clone();
    p.push(match self.dev_mode {
      DevMode::Beta => "target.web.beta",
      DevMode::ReleaseCandidate => "target.web.rc",
      DevMode::Prod => "target.web",
    });
    p.push(domain);
    p.push(path);
    p
  }
}
