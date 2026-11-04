//! `autophys pair | keys | db`: the daemon's admin commands, run on the
//! daemon host against the same files the daemon uses (SQLite serialises the
//! writers). `pair` and `keys` use the server database; `db` uses the
//! workbooks of the collection. Output never contains a key or a device code.
//!
//! ```text
//! autophys pair list                       pending pairings
//! autophys pair approve WXYZ-1234          let that device's next poll get a key
//! autophys pair deny WXYZ-1234
//! autophys keys list [--json]              id, device, created, last used, revoked
//! autophys keys revoke k_7f3a…
//! autophys db verify [--rebuild] [--json] [--project NAME]
//!                                          verify every workbook's chains and
//!                                          projections (`wb.verify()`); with
//!                                          --rebuild, replace drifted projections
//! ```
//! `db check` is the same as `db verify`. Every command takes
//! `--collection <dir>` (alias `--db`) and `--server-db <file>`; the caller
//! supplies the defaults.

use std::io::Write;
use std::path::PathBuf;
use std::process::ExitCode;

use autophys::VerifyReport;
use serde_json::json;

use crate::error::ApiError;
use crate::keys::KeyStore;

pub const USAGE: &str = "\
usage: autophys pair list | pair approve <CODE> | pair deny <CODE>
       autophys keys list [--json] | keys revoke <KEY_ID>
       autophys db verify [--rebuild] [--json] [--project NAME]   (db check is the same)
       (each also takes --collection <dir> (alias --db) and --server-db <file>)";

struct Args {
    words: Vec<String>,
    collection: Option<PathBuf>,
    server_db: Option<PathBuf>,
    project: Option<String>,
    json: bool,
    rebuild: bool,
}

fn parse(args: impl IntoIterator<Item = String>) -> Result<Args, String> {
    let mut out = Args {
        words: Vec::new(),
        collection: None,
        server_db: None,
        project: None,
        json: false,
        rebuild: false,
    };
    let mut it = args.into_iter();
    while let Some(arg) = it.next() {
        let (key, inline) = match arg.split_once('=') {
            Some((k, v)) if k.starts_with("--") => (k.to_string(), Some(v.to_string())),
            _ => (arg.clone(), None),
        };
        let mut value = |name: &str| -> Result<String, String> {
            inline
                .clone()
                .or_else(|| it.next())
                .ok_or(format!("{name} needs a value"))
        };
        match key.as_str() {
            "--json" => out.json = true,
            "--rebuild" => out.rebuild = true,
            "--collection" | "--db" => out.collection = Some(value(&key)?.into()),
            "--server-db" => out.server_db = Some(value(&key)?.into()),
            "--project" => out.project = Some(value(&key)?),
            s if s.starts_with("--") => return Err(format!("unknown flag {s:?}")),
            _ => out.words.push(arg),
        }
    }
    Ok(out)
}

/// Where the admin commands find the collection and the server database.
pub struct Defaults {
    pub collection: PathBuf,
    /// The server database in app data (or an explicitly configured path).
    pub server_db: PathBuf,
}

/// Run `command` (`pair`, `keys` or `db`) with its remaining arguments.
/// Writes to `out`; errors go to `err`. Exit codes: 0 ok, 1 failed (or
/// `db verify` found problems), 2 usage.
pub fn run(
    command: &str,
    args: impl IntoIterator<Item = String>,
    defaults: Defaults,
    out: &mut impl Write,
    err: &mut impl Write,
) -> ExitCode {
    let args = match parse(args) {
        Ok(a) => a,
        Err(m) => return usage(err, &m),
    };
    let words: Vec<&str> = args.words.iter().map(String::as_str).collect();
    let valid = matches!(
        (command, words.as_slice()),
        ("pair", ["list"] | ["approve" | "deny", _])
            | ("keys", ["list"] | ["revoke", _])
            | ("db", ["verify" | "check"])
    );
    if !valid {
        return usage(err, &format!("{command} {}", words.join(" ")));
    }
    let collection = args.collection.clone().unwrap_or(defaults.collection);
    if command == "db" {
        return db_verify(&args, &collection, out, err);
    }
    let server_db = args.server_db.clone().unwrap_or(defaults.server_db);
    let keys = match KeyStore::open(&server_db) {
        Ok(k) => k,
        Err(e) => return fail(err, &format!("open {}: {e}", server_db.display())),
    };
    let result: Result<ExitCode, ApiError> = match (command, words.as_slice()) {
        ("pair", ["list"]) => keys.pairings_pending().map(|rows| {
            if rows.is_empty() {
                let _ = writeln!(out, "no pending pairings");
            }
            for p in rows {
                let _ = writeln!(
                    out,
                    "{}  {}  ({})  expires {}",
                    p.user_code, p.device_name, p.client, p.expires
                );
            }
            ExitCode::SUCCESS
        }),
        ("pair", ["approve", code]) => keys.pair_approve(code).map(|p| {
            let _ = writeln!(
                out,
                "approved {} for {}; its next poll receives a key",
                p.user_code, p.device_name
            );
            ExitCode::SUCCESS
        }),
        ("pair", ["deny", code]) => keys.pair_deny(code).map(|p| {
            let _ = writeln!(out, "denied {} for {}", p.user_code, p.device_name);
            ExitCode::SUCCESS
        }),
        ("keys", ["list"]) => keys.keys_list().map(|list| {
            if args.json {
                let _ = writeln!(
                    out,
                    "{}",
                    serde_json::to_string_pretty(&list).unwrap_or_default()
                );
            } else {
                for k in list {
                    let used = k.last_used.as_deref().unwrap_or("never");
                    let state = k
                        .revoked
                        .as_deref()
                        .map_or("live".to_string(), |t| format!("revoked {t}"));
                    let _ = writeln!(
                        out,
                        "{}  {}  created {}  last used {}  {}",
                        k.id, k.device, k.created, used, state
                    );
                }
            }
            ExitCode::SUCCESS
        }),
        ("keys", ["revoke", id]) => keys.keys_revoke(id).map(|live| {
            let _ = writeln!(
                out,
                "{id} {}",
                if live {
                    "revoked"
                } else {
                    "was already revoked"
                }
            );
            ExitCode::SUCCESS
        }),
        _ => unreachable!("checked above"),
    };
    result.unwrap_or_else(|e| fail(err, &e.to_string()))
}

/// `db verify`: `wb.verify()` on every workbook (or `--project`'s), with
/// `--rebuild` replacing drifted projections first.
fn db_verify(
    args: &Args,
    collection: &std::path::Path,
    out: &mut impl Write,
    err: &mut impl Write,
) -> ExitCode {
    let text = collection.to_string_lossy();
    let reports = (|| -> autophys::Result<Vec<(String, String, VerifyReport, bool)>> {
        let client = autophys::connect(Some(&text))?;
        let mut rows = Vec::new();
        for wb in client.workbooks()? {
            if args.project.as_deref().is_some_and(|p| p != wb.name()) {
                continue;
            }
            let mut report = wb.verify()?;
            let mut rebuilt = false;
            if args.rebuild && report.chain_errors.is_empty() && !report.projections_match {
                report = wb.rebuild_projections()?;
                rebuilt = true;
            }
            rows.push((
                wb.name().to_string(),
                wb.path().display().to_string(),
                report,
                rebuilt,
            ));
        }
        Ok(rows)
    })();
    let rows = match reports {
        Ok(r) => r,
        Err(e) => return fail(err, &format!("{}: {e}", collection.display())),
    };
    if let Some(p) = &args.project
        && rows.is_empty()
    {
        return fail(
            err,
            &format!("no project {p:?} in {}", collection.display()),
        );
    }
    if args.json {
        let list: Vec<_> = rows
            .iter()
            .map(|(name, path, r, rebuilt)| {
                json!({"project": name, "path": path, "report": r, "rebuilt": rebuilt})
            })
            .collect();
        let _ = writeln!(
            out,
            "{}",
            serde_json::to_string_pretty(&list).unwrap_or_default()
        );
    } else {
        if rows.is_empty() {
            let _ = writeln!(out, "no workbooks in {}", collection.display());
        }
        for (name, path, r, rebuilt) in &rows {
            let _ = writeln!(
                out,
                "{name} ({path}): {} records in {} investigations",
                r.records, r.investigations
            );
            for e in &r.chain_errors {
                let _ = writeln!(
                    out,
                    "  chain error: {} seq {} ({}): {}",
                    e.investigation, e.seq, e.id, e.problem
                );
            }
            let proj = match (r.projections_match, rebuilt) {
                (true, false) => "projections match the records",
                (false, _) => "projections differ from the records; run with --rebuild",
                (true, true) => "projections rebuilt from the records (they had drifted)",
            };
            let _ = writeln!(out, "  {proj}");
        }
    }
    if rows.iter().all(|(_, _, r, _)| r.ok) {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}

fn usage(err: &mut impl Write, m: &str) -> ExitCode {
    let _ = writeln!(err, "autophys: {m}\n{USAGE}");
    ExitCode::from(2)
}

fn fail(err: &mut impl Write, m: &str) -> ExitCode {
    let _ = writeln!(err, "autophys: {m}");
    ExitCode::FAILURE
}
