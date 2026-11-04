//! `autophys pair | keys | db`: the store's admin commands, run on the daemon
//! host against the same database file the daemon uses (SQLite serialises
//! the two writers). Output never contains a key or a device code.
//!
//! ```text
//! autophys pair list                       pending pairings
//! autophys pair approve WXYZ-1234          let that device's next poll get a key
//! autophys pair deny WXYZ-1234
//! autophys keys list [--json]              id, device, created, last used, revoked
//! autophys keys revoke k_7f3a…
//! autophys db check [--rebuild] [--json]   verify every hash chain; compare or
//!                                          rebuild the projections
//! ```
//! Every command takes `--db <path>`; the caller supplies the default.

use std::io::Write;
use std::path::PathBuf;
use std::process::ExitCode;

use crate::store::Store;

pub const USAGE: &str = "\
usage: autophys pair list | pair approve <CODE> | pair deny <CODE>
       autophys keys list [--json] | keys revoke <KEY_ID>
       autophys db check [--rebuild] [--json]
       (each also takes --db <path>)";

struct Args {
    words: Vec<String>,
    db: Option<PathBuf>,
    json: bool,
    rebuild: bool,
}

fn parse(args: impl IntoIterator<Item = String>) -> Result<Args, String> {
    let mut out = Args {
        words: Vec::new(),
        db: None,
        json: false,
        rebuild: false,
    };
    let mut it = args.into_iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--json" => out.json = true,
            "--rebuild" => out.rebuild = true,
            "--db" => out.db = Some(it.next().ok_or("--db needs a path")?.into()),
            s if s.starts_with("--db=") => out.db = Some(s["--db=".len()..].into()),
            s if s.starts_with("--") => return Err(format!("unknown flag {s:?}")),
            _ => out.words.push(arg),
        }
    }
    Ok(out)
}

/// Run `command` (`pair`, `keys` or `db`) with its remaining arguments.
/// `default_db` is used when no `--db` is given. Writes to `out`; errors go
/// to `err`. Exit codes: 0 ok, 1 failed (or `db check` found problems),
/// 2 usage.
pub async fn run(
    command: &str,
    args: impl IntoIterator<Item = String>,
    default_db: impl FnOnce() -> Result<PathBuf, String>,
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
            | ("db", ["check"])
    );
    if !valid {
        return usage(err, &format!("{command} {}", words.join(" ")));
    }
    let db = match args.db.map(Ok).unwrap_or_else(default_db) {
        Ok(db) => db,
        Err(m) => return fail(err, &m),
    };
    let store = match Store::open(&db) {
        Ok(s) => s,
        Err(e) => return fail(err, &format!("open {}: {e}", db.display())),
    };
    let result = match (command, words.as_slice()) {
        ("pair", ["list"]) => store.pairings_pending().await.map(|rows| {
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
        ("pair", ["approve", code]) => store.pair_approve(code).await.map(|p| {
            let _ = writeln!(
                out,
                "approved {} for {}; its next poll receives a key",
                p.user_code, p.device_name
            );
            ExitCode::SUCCESS
        }),
        ("pair", ["deny", code]) => store.pair_deny(code).await.map(|p| {
            let _ = writeln!(out, "denied {} for {}", p.user_code, p.device_name);
            ExitCode::SUCCESS
        }),
        ("keys", ["list"]) => store.keys_list().await.map(|keys| {
            if args.json {
                let _ = writeln!(
                    out,
                    "{}",
                    serde_json::to_string_pretty(&keys).unwrap_or_default()
                );
            } else {
                for k in keys {
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
        ("keys", ["revoke", id]) => store.keys_revoke(id).await.map(|live| {
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
        ("db", ["check"]) => store.db_check(args.rebuild).await.map(|r| {
            if args.json {
                let _ = writeln!(
                    out,
                    "{}",
                    serde_json::to_string_pretty(&r).unwrap_or_default()
                );
            } else {
                let _ = writeln!(
                    out,
                    "{} records in {} investigations",
                    r.records, r.investigations
                );
                for e in &r.chain_errors {
                    let _ = writeln!(
                        out,
                        "chain error: {} seq {} ({}): {}",
                        e.investigation, e.seq, e.id, e.problem
                    );
                }
                let proj = match (r.projections_match, r.rebuilt) {
                    (true, false) => "projections match the log",
                    (false, false) => "projections differ from the log; run with --rebuild",
                    (true, true) => "projections rebuilt (they already matched)",
                    (false, true) => "projections rebuilt from the log (they had drifted)",
                };
                let _ = writeln!(out, "{proj}");
            }
            if r.chain_errors.is_empty() && (r.projections_match || r.rebuilt) {
                ExitCode::SUCCESS
            } else {
                ExitCode::FAILURE
            }
        }),
        _ => unreachable!("checked above"),
    };
    result.unwrap_or_else(|e| fail(err, &e.to_string()))
}

fn usage(err: &mut impl Write, m: &str) -> ExitCode {
    let _ = writeln!(err, "autophys: {m}\n{USAGE}");
    ExitCode::from(2)
}

fn fail(err: &mut impl Write, m: &str) -> ExitCode {
    let _ = writeln!(err, "autophys: {m}");
    ExitCode::FAILURE
}
