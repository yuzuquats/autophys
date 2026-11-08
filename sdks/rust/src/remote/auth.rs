//! Python-compatible pairing credentials and device-code flow. The pairing
//! calls are async; [`crate::blocking::auth`] has their synchronous forms.
use super::{HttpError, Remote};
use crate::{Error, Result};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    path::PathBuf,
    time::{Duration, Instant},
};

pub const DEFAULT_SERVER: &str = "http://127.0.0.1:4794";

#[derive(Clone, Serialize, Deserialize)]
pub struct Credentials {
    pub server: String,
    pub api_key: String,
    #[serde(default = "empty_key_id")]
    pub key_id: Option<String>,
    #[serde(default)]
    pub account: String,
    #[serde(default)]
    pub device_name: String,
}
fn empty_key_id() -> Option<String> {
    Some(String::new())
}
impl std::fmt::Debug for Credentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Credentials")
            .field("server", &self.server)
            .field("key_id", &self.key_id)
            .field("account", &self.account)
            .finish()
    }
}
pub fn config_dir() -> PathBuf {
    std::env::var_os("AUTOPHYS_CONFIG_DIR")
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".config/autophys")
        })
}
pub fn credentials_path() -> PathBuf {
    config_dir().join("credentials")
}

/// Environment key wins, but an existing insecure credentials file is still refused.
pub fn load_credentials(server: Option<&str>) -> Result<Option<Credentials>> {
    load_at(
        &credentials_path(),
        server,
        std::env::var("AUTOPHYS_API_KEY")
            .ok()
            .filter(|s| !s.is_empty()),
        std::env::var("AUTOPHYS_SERVER")
            .ok()
            .filter(|s| !s.is_empty()),
    )
}
fn load_at(
    path: &std::path::Path,
    server: Option<&str>,
    key: Option<String>,
    env_server: Option<String>,
) -> Result<Option<Credentials>> {
    let mut saved = match std::fs::metadata(path) {
        Ok(meta) => {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mode = meta.permissions().mode() & 0o7777;
                if mode & 0o077 != 0 {
                    return Err(Error::Io(format!(
                        "{} is readable by others (mode {mode:o}); run chmod 600",
                        path.display()
                    )));
                }
            }
            #[cfg(not(unix))]
            let _ = meta;
            Some(
                serde_json::from_slice::<Credentials>(
                    &std::fs::read(path)
                        .map_err(|_| Error::Io("cannot read credentials".into()))?,
                )
                .map_err(|_| Error::Io("invalid credentials file".into()))?,
            )
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(_) => return Err(Error::Io("cannot read credentials".into())),
    };
    let resolved = server
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .or(env_server)
        .or_else(|| saved.as_ref().map(|c| c.server.clone()))
        .unwrap_or_else(|| DEFAULT_SERVER.into());
    let resolved = super::normalize_server(&resolved)?;
    if let Some(api_key) = key {
        return Ok(Some(Credentials {
            server: resolved,
            api_key,
            key_id: None,
            account: String::new(),
            device_name: String::new(),
        }));
    }
    if let Some(c) = &mut saved {
        if super::normalize_server(&c.server)? != resolved {
            return Err(Error::BadRequest("saved credentials belong to a different server; supply an explicit API key".into()));
        }
        c.server = resolved;
    }
    Ok(saved)
}

/// Write atomically with mode 0600. Neither Debug nor errors expose the key.
pub fn save_credentials(creds: &Credentials) -> Result<PathBuf> {
    save_at(creds, &credentials_path())
}
fn save_at(creds: &Credentials, path: &std::path::Path) -> Result<PathBuf> {
    use std::io::Write;
    let dir = path
        .parent()
        .ok_or_else(|| Error::Io("invalid credentials path".into()))?;
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder
        .create(dir)
        .map_err(|_| Error::Io("cannot create credentials directory".into()))?;
    let tmp = dir.join(format!(
        "credentials.{}.tmp",
        crate::workbook::random_hex(12)?
    ));
    let mut opts = std::fs::OpenOptions::new();
    opts.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let result = (|| {
        let mut file = opts
            .open(&tmp)
            .map_err(|_| Error::Io("cannot save credentials".into()))?;
        let data =
            serde_json::to_vec(creds).map_err(|_| Error::Io("cannot encode credentials".into()))?;
        file.write_all(&data)
            .and_then(|_| file.sync_all())
            .map_err(|_| Error::Io("cannot save credentials".into()))?;
        std::fs::rename(&tmp, path).map_err(|_| Error::Io("cannot replace credentials".into()))?;
        Ok(path.to_path_buf())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

#[derive(Clone, Deserialize)]
pub struct PairingStart {
    pub device_code: String,
    pub user_code: String,
    pub verification_url: String,
    pub interval: f64,
    pub expires_in: f64,
}
impl std::fmt::Debug for PairingStart {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PairingStart")
            .field("user_code", &self.user_code)
            .field("verification_url", &self.verification_url)
            .finish()
    }
}
pub async fn pair_start(server: &str, device_name: &str) -> Result<PairingStart> {
    let remote = Remote::new(server, "")?;
    let (_, mut v) = remote.json(
        "POST",
        "/pair/start",
        Some(&json!({"device_name":device_name,"client":super::USER_AGENT})),
        None,
        remote.timeout,
    ).await?;
    if v.get("interval").is_none() {
        v["interval"] = json!(5);
    }
    if v.get("expires_in").is_none() {
        v["expires_in"] = json!(600);
    }
    super::decode(v)
}
pub async fn pair_poll(server: &str, start: &PairingStart, device_name: &str) -> Result<Credentials> {
    let remote = Remote::new(server, "")?;
    if !start.interval.is_finite()
        || start.interval < 0.0
        || !start.expires_in.is_finite()
        || start.expires_in < 0.0
    {
        return Err(Error::BadRequest(
            "invalid pairing interval or expiry".into(),
        ));
    }
    let begun = Instant::now();
    let expires = Duration::try_from_secs_f64(start.expires_in)
        .map_err(|_| Error::BadRequest("invalid pairing expiry".into()))?;
    let mut interval = start.interval;
    loop {
        match remote.json(
            "POST",
            "/pair/poll",
            Some(&json!({"device_code":start.device_code})),
            None,
            remote.timeout,
        ).await {
            Ok((_, v)) => {
                return Ok(Credentials {
                    server: server.into(),
                    api_key: v["api_key"]
                        .as_str()
                        .ok_or_else(|| Error::Io("invalid pairing response".into()))?
                        .into(),
                    key_id: v["key_id"].as_str().map(str::to_owned),
                    account: v["account"].as_str().unwrap_or("").into(),
                    device_name: device_name.into(),
                });
            }
            Err(Error::Http(e)) if e.error == "authorization_pending" => {}
            Err(Error::Http(e)) if e.error == "slow_down" => interval += 5.0,
            Err(e) => return Err(e),
        }
        if begun.elapsed() >= expires {
            return Err(HttpError::new(
                400,
                "expired_token",
                "pairing code expired before approval",
            )
            .into());
        }
        tokio::time::sleep(Duration::from_secs_f64(interval)).await;
    }
}
pub async fn whoami(creds: &Credentials) -> Result<serde_json::Value> {
    let r = Remote::new(&creds.server, &creds.api_key)?;
    r.json("GET", "/whoami", None, None, r.timeout)
        .await
        .map(|(_, v)| v)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn discovery_and_secure_save() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config/credentials");
        let c = Credentials {
            server: "http://saved".into(),
            api_key: "secret-marker".into(),
            key_id: Some("key".into()),
            account: "a".into(),
            device_name: "d".into(),
        };
        save_at(&c, &path).unwrap();
        assert!(!format!("{c:?}").contains("secret-marker"));
        let got = load_at(&path, None, None, None).unwrap().unwrap();
        assert_eq!(got.server, c.server);
        let got = load_at(
            &path,
            Some("http://explicit"),
            Some("environment".into()),
            Some("http://env".into()),
        )
        .unwrap()
        .unwrap();
        assert_eq!(got.server, "http://explicit");
        assert_eq!(got.api_key, "environment");
        assert_eq!(got.key_id, None);
        assert!(load_at(&path, None, None, Some("http://env".into())).is_err());
        assert!(load_at(&path, Some("http://other"), None, None).is_err());
        let got = load_at(&path, Some("HTTP://SAVED:80/"), None, None).unwrap().unwrap();
        assert_eq!(got.server, "http://saved");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
            let err = load_at(&path, None, Some("environment".into()), None).unwrap_err();
            assert!(
                err.to_string()
                    .contains("readable by others (mode 644); run chmod 600")
            );
        }
    }
}
