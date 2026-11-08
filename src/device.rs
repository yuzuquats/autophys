//! `autophys connect` and `autophys whoami`: the device side of pairing.
//!
//! `connect` runs the device-code flow against a daemon's `/api/v1/pair/*`
//! routes (the server's operator approves the printed code in the browser or
//! with `autophys pair approve`) and saves the issued key to
//! `~/.config/autophys/credentials` (mode 0600; `AUTOPHYS_CONFIG_DIR`
//! overrides the directory). Both SDKs read that file. `whoami` reads
//! `AUTOPHYS_API_KEY` or that file and asks the server whose key it is.
//! Neither command prints the key.
use std::io::Write;
use std::process::Command;

use autophys::blocking::auth;
use autophys::{Error, HttpError};
use serde_json::{Value, json};

pub const CONNECT_USAGE: &str = "usage: autophys connect [URL | --server URL] [--name NAME] [--json]";
pub const WHOAMI_USAGE: &str = "usage: autophys whoami [--server URL] [--json]";

/// A failed command: its message and exit status (2 for usage, else 1 or 2
/// as the Python CLI it replaces used them).
#[derive(Debug)]
pub struct Failure {
    pub code: u8,
    pub message: String,
}

impl Failure {
    fn new(code: u8, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
    fn usage(message: impl std::fmt::Display, usage: &str) -> Self {
        Self::new(2, format!("{message}\n{usage}"))
    }
}

#[derive(Debug)]
struct ConnectArgs {
    server: Option<String>,
    name: Option<String>,
    json: bool,
}

fn parse_connect(args: Vec<String>) -> Result<ConnectArgs, Failure> {
    let mut parsed = ConnectArgs {
        server: None,
        name: None,
        json: false,
    };
    let mut words = args.into_iter();
    while let Some(word) = words.next() {
        match word.as_str() {
            "--json" => parsed.json = true,
            "--name" => {
                parsed.name = Some(
                    words
                        .next()
                        .ok_or_else(|| Failure::usage("--name needs a value", CONNECT_USAGE))?,
                )
            }
            "--server" => {
                parsed.server = Some(
                    words
                        .next()
                        .ok_or_else(|| Failure::usage("--server needs a URL", CONNECT_USAGE))?,
                )
            }
            other if other.starts_with("--name=") => parsed.name = Some(other[7..].to_string()),
            other if other.starts_with("--server=") => parsed.server = Some(other[9..].to_string()),
            other if other.starts_with('-') => {
                return Err(Failure::usage(
                    format!("unknown option {other:?}"),
                    CONNECT_USAGE,
                ));
            }
            _ if parsed.server.is_none() => parsed.server = Some(word),
            _ => {
                return Err(Failure::usage(
                    format!("unexpected argument {word:?}"),
                    CONNECT_USAGE,
                ));
            }
        }
    }
    if parsed.name.as_deref().is_some_and(|n| n.trim().is_empty()) {
        return Err(Failure::usage("--name is empty", CONNECT_USAGE));
    }
    Ok(parsed)
}

fn env(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|v| !v.is_empty())
}

/// The URL given, else `AUTOPHYS_SERVER`, else the saved server, else the
/// local default. A first connect (no credentials file) still honours
/// `AUTOPHYS_SERVER`; an unreadable saved file is replaced, not consulted.
fn connect_server(explicit: Option<String>) -> String {
    explicit
        .or_else(|| env("AUTOPHYS_SERVER"))
        .or_else(|| {
            auth::load_credentials(None)
                .ok()
                .flatten()
                .map(|c| c.server)
        })
        .unwrap_or_else(|| auth::DEFAULT_SERVER.to_string())
}

fn device_name() -> String {
    Command::new("hostname")
        .output()
        .ok()
        .filter(|out| out.status.success())
        .and_then(|out| String::from_utf8(out.stdout).ok())
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "autophys-device".into())
}

fn http_reason(e: &HttpError) -> String {
    if e.message.is_empty() {
        e.error.clone()
    } else {
        format!("{} ({})", e.error, e.message)
    }
}

/// `autophys connect`: pair this device and save its key. Progress goes to
/// stdout, or to stderr with `--json` so stdout stays one JSON object.
pub fn connect(args: Vec<String>, out: &mut impl Write) -> Result<Value, Failure> {
    let args = parse_connect(args)?;
    let server = connect_server(args.server);
    let name = args.name.unwrap_or_else(device_name);
    let start = auth::pair_start(&server, &name)
        .map_err(|e| Failure::new(2, format!("pairing could not start at {server}: {e}")))?;
    let mut progress: Box<dyn Write> = if args.json {
        Box::new(std::io::stderr())
    } else {
        Box::new(&mut *out)
    };
    let _ = writeln!(
        progress,
        "To connect this device, open {} and enter code: {}",
        start.verification_url, start.user_code
    );
    let _ = writeln!(
        progress,
        "Waiting for approval (expires in {} s)...",
        start.expires_in as u64
    );
    let _ = progress.flush();
    let creds = auth::pair_poll(&server, &start, &name).map_err(|e| match e {
        Error::Http(e) => Failure::new(1, format!("pairing failed: {}", http_reason(&e))),
        other => Failure::new(
            2,
            format!("pairing failed: could not reach {server}: {other}"),
        ),
    })?;
    let path = auth::save_credentials(&creds).map_err(|e| Failure::new(1, e.to_string()))?;
    let account = if creds.account.is_empty() {
        "(unknown account)"
    } else {
        &creds.account
    };
    let key_id = creds.key_id.as_deref().filter(|k| !k.is_empty());
    let _ = writeln!(
        progress,
        "Connected as {account}; key {} saved to {}",
        key_id.unwrap_or("(no id)"),
        path.display()
    );
    drop(progress);
    Ok(if args.json {
        json!({
            "server": creds.server,
            "account": creds.account,
            "key_id": key_id,
            "device_name": creds.device_name,
            "credentials": path.display().to_string(),
        })
    } else {
        Value::Null
    })
}

/// `autophys whoami`: the account, workspace and device the key belongs to.
pub fn whoami(args: Vec<String>, out: &mut impl Write) -> Result<Value, Failure> {
    let mut server = None;
    let mut json = false;
    let mut words = args.into_iter();
    while let Some(word) = words.next() {
        match word.as_str() {
            "--json" => json = true,
            "--server" => {
                server = Some(
                    words
                        .next()
                        .ok_or_else(|| Failure::usage("--server needs a URL", WHOAMI_USAGE))?,
                )
            }
            other => {
                return Err(Failure::usage(
                    format!("unexpected argument {other:?}"),
                    WHOAMI_USAGE,
                ));
            }
        }
    }
    let creds = auth::load_credentials(server.as_deref())
        .map_err(|e| Failure::new(1, e.to_string()))?
        .ok_or_else(|| {
            Failure::new(
                1,
                "not connected: run `autophys connect URL` or set AUTOPHYS_API_KEY",
            )
        })?;
    let me = auth::whoami(&creds).map_err(|e| match e {
        Error::Http(e) if e.is_auth() => Failure::new(
            1,
            format!(
                "the server rejected the key ({}); run `autophys connect` again",
                e.error
            ),
        ),
        other => Failure::new(2, format!("could not reach {}: {other}", creds.server)),
    })?;
    if json {
        return Ok(me);
    }
    let field = |key: &str| match &me[key] {
        Value::String(text) => text.clone(),
        Value::Null => "-".into(),
        other => other.to_string(),
    };
    let _ = writeln!(out, "account:   {}", field("account"));
    let _ = writeln!(out, "workspace: {}", field("workspace"));
    let _ = writeln!(out, "key:       {}", field("key_id"));
    let _ = writeln!(out, "device:    {}", field("device_name"));
    let _ = writeln!(out, "server:    {}", creds.server);
    Ok(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(text: &str) -> Vec<String> {
        text.split_whitespace().map(str::to_string).collect()
    }

    #[test]
    fn connect_arguments() {
        let a = parse_connect(words("http://h:1 --name lab --json")).unwrap();
        assert_eq!(a.server.as_deref(), Some("http://h:1"));
        assert_eq!(a.name.as_deref(), Some("lab"));
        assert!(a.json);
        let a = parse_connect(words("--name=lab")).unwrap();
        assert_eq!((a.server, a.name.as_deref()), (None, Some("lab")));
        for bad in ["--name", "--bogus", "http://a http://b"] {
            assert_eq!(parse_connect(words(bad)).unwrap_err().code, 2, "{bad}");
        }
    }
}
