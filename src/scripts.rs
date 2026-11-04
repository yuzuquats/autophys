//! The autophys command tree. Construction reflects commands only: it reads
//! no environment, credentials, workbooks or server database.
use std::io::Write;
use std::process::ExitCode;

use serde::Deserialize;
use serde_json::{Value, json};
use tento_sh::{CommandArg, Scripts, command};

pub fn scripts() -> Scripts<()> {
    let mut tree = Scripts::new(())
        .with_app_identity("autophys", env!("CARGO_PKG_VERSION"), "autophys")
        .add_command(serve)
        .add_command(build_web)
        .add_command(pack)
        .add_subcommand("pair", pair_commands())
        .add_subcommand("keys", keys_commands())
        .add_subcommand("db", db_commands())
        .add_command(projects)
        .add_command(investigations)
        .add_command(records)
        .add_command(approve)
        .add_command(reject)
        .add_command(verify);
    tree.name = Some("autophys".into());
    tree
}

fn pair_commands() -> Scripts<()> {
    Scripts::new(())
        .add_command(pair_list)
        .add_command(pair_approve)
        .add_command(pair_deny)
}
fn keys_commands() -> Scripts<()> {
    Scripts::new(())
        .add_command(keys_list)
        .add_command(keys_revoke)
}
fn db_commands() -> Scripts<()> {
    Scripts::new(())
        .add_command(db_verify)
        .add_command(db_check)
}

fn description(root: &Scripts<()>) -> Value {
    // The vendored root manifest reflects leaf commands. Compose its nested
    // groups through the same public registry reflection, with no env access.
    let mut doc = root.self_description();
    for (name, group) in [
        ("pair", pair_commands()),
        ("keys", keys_commands()),
        ("db", db_commands()),
    ] {
        doc["commands"][name] = tento_sh::command_index_value(&group);
    }
    doc
}

fn usage(message: impl Into<String>) -> tento_sh::Error {
    tento_sh::Error::ArgParseError(message.into())
}

/// The existing daemon parsers retain repeatable flags, aliases and env
/// precedence. The Scripts registry owns dispatch; these adapters feed those
/// parsers the original argument words rather than changing their grammar.
#[command(
    name = "serve",
    description = "Serve on loopback: --addr, --web-root, --collection (--db), --server-db, repeatable --browser-origin"
)]
async fn serve(_: (), args: Option<Vec<String>>) -> tento_sh::Result<()> {
    let config = crate::parse_serve(args.unwrap_or_default(), |key| std::env::var(key).ok())
        .map_err(usage)?;
    crate::run(config).await?;
    Ok(())
}

#[command(
    name = "build-web",
    description = "Build the web app: [--out DIR] [--bundle FILE]"
)]
async fn build_web(_: (), args: Option<Vec<String>>) -> tento_sh::Result<Value> {
    let (args, bundle) = crate::embedded::parse_bundle(args.unwrap_or_default()).map_err(usage)?;
    let out = crate::parse_build_web(args)
        .map_err(usage)?
        .map(Ok)
        .unwrap_or_else(crate::default_web_root)?;
    let root = crate::build_web(crate::project_root(), out).await?;
    if let Some(out) = bundle {
        crate::embedded::pack(
            &std::env::current_exe().map_err(anyhow::Error::from)?,
            &root,
            &out,
            true,
        )?;
        Ok(Value::String(out.display().to_string()))
    } else {
        Ok(Value::String(root.display().to_string()))
    }
}

#[command(
    name = "pack",
    description = "Pack a single native file: --web-root DIR --out FILE [--no-maps]"
)]
async fn pack(_: (), args: Option<Vec<String>>) -> tento_sh::Result<Value> {
    let args = crate::embedded::parse_pack(args.unwrap_or_default()).map_err(usage)?;
    crate::embedded::pack(
        &std::env::current_exe().map_err(anyhow::Error::from)?,
        &args.web_root,
        &args.out,
        args.with_maps,
    )?;
    Ok(Value::String(args.out.display().to_string()))
}

fn admin(group: &str, action: &str, args: Vec<String>) -> tento_sh::Result<Value> {
    let defaults = crate::admin::Defaults {
        collection: crate::default_collection(),
        server_db: std::env::var_os("AUTOPHYS_SERVER_DB")
            .map(std::path::PathBuf::from)
            .map(Ok)
            .unwrap_or_else(crate::default_server_db)?,
    };
    let mut argv = vec![action.to_string()];
    argv.extend(args);
    if group == "db" || (group == "keys" && action == "list") {
        argv.push("--json".into());
    }
    let (mut out, mut err) = (Vec::new(), Vec::new());
    let status = crate::admin::run(group, argv, defaults, &mut out, &mut err);
    if status != ExitCode::SUCCESS {
        // Verification failures carry useful reports, not an invocation error.
        // Return them normally so Scripts does not append usage to JSON output.
        if group == "db" && status == ExitCode::FAILURE {
            if let Ok(reports) = serde_json::from_slice::<Value>(&out) {
                return Ok(reports);
            }
        }
        let message = String::from_utf8_lossy(&err).trim().to_string();
        if status == ExitCode::from(2) {
            return Err(usage(message));
        }
        if !out.is_empty() {
            print!("{}", String::from_utf8_lossy(&out));
        }
        return Err(tento_sh::Error::ProcessExit {
            status: Some(1),
            signal: None,
            detail: message,
        });
    }
    let text = String::from_utf8(out).map_err(anyhow::Error::from)?;
    Ok(serde_json::from_str(&text).unwrap_or_else(|_| Value::String(text.trim_end().to_string())))
}

macro_rules! admin_command {
    ($function:ident, $name:literal, $description:literal, $group:literal, $action:literal) => {
        #[command(name = $name, description = $description)]
        async fn $function(_: (), args: Option<Vec<String>>) -> tento_sh::Result<Value> {
            admin($group, $action, args.unwrap_or_default())
        }
    };
}
admin_command!(
    pair_list,
    "list",
    "List pending devices; --collection (--db), --server-db",
    "pair",
    "list"
);
admin_command!(
    pair_approve,
    "approve",
    "Approve CODE; --collection (--db), --server-db",
    "pair",
    "approve"
);
admin_command!(
    pair_deny,
    "deny",
    "Deny CODE; --collection (--db), --server-db",
    "pair",
    "deny"
);
admin_command!(
    keys_list,
    "list",
    "List keys; --json, --collection (--db), --server-db",
    "keys",
    "list"
);
admin_command!(
    keys_revoke,
    "revoke",
    "Revoke KEY_ID; --collection (--db), --server-db",
    "keys",
    "revoke"
);
admin_command!(
    db_verify,
    "verify",
    "Verify workbooks; --rebuild, --project, --json, --collection (--db), --server-db",
    "db",
    "verify"
);
admin_command!(db_check, "check", "Alias of db verify", "db", "check");

#[derive(CommandArg, Deserialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct TargetArgs {
    /// Collection directory, .ap-workbook file, or URL; AUTOPHYS_HOME or ~/autophys by default.
    target: Option<String>,
}

#[derive(CommandArg, Deserialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct ProjectArgs {
    target: Option<String>,
    /// Restrict results to an existing project's name or id.
    project: Option<String>,
}

#[derive(CommandArg, Deserialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct RecordArgs {
    #[arg(positional)]
    investigation: String,
    target: Option<String>,
    kind: Option<String>,
}

#[derive(CommandArg, Deserialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct ApproveArgs {
    #[arg(positional)]
    investigation: String,
    #[arg(positional)]
    proposal: String,
    target: Option<String>,
    #[arg(default = "operator")]
    by: String,
    /// Edited settings as a JSON object; omitted to approve unchanged.
    settings: Option<Value>,
}

#[derive(CommandArg, Deserialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct RejectArgs {
    #[arg(positional)]
    investigation: String,
    #[arg(positional)]
    proposal: String,
    target: Option<String>,
    #[arg(default = "operator")]
    by: String,
    #[arg(default = "")]
    reason: String,
}

#[command(
    name = "projects",
    description = "List projects through the SDK; --target DIR|FILE|URL, --json"
)]
async fn projects(_: (), args: TargetArgs) -> tento_sh::Result<Value> {
    let client = autophys::connect(args.target.as_deref()).map_err(anyhow::Error::from)?;
    Ok(
        serde_json::to_value(client.projects().map_err(anyhow::Error::from)?)
            .map_err(anyhow::Error::from)?,
    )
}

#[command(
    name = "investigations",
    description = "List investigations; --target DIR|FILE|URL, --project NAME, --json"
)]
async fn investigations(_: (), args: ProjectArgs) -> tento_sh::Result<Value> {
    let client = autophys::connect(args.target.as_deref()).map_err(anyhow::Error::from)?;
    let project = if let Some(project) = args.project {
        Some(
            client
                .projects()
                .map_err(anyhow::Error::from)?
                .into_iter()
                .find(|entry| entry.name == project || entry.id == project)
                .ok_or_else(|| anyhow::anyhow!("project not found: {project}"))?
                .id,
        )
    } else {
        None
    };
    Ok(serde_json::to_value(
        client
            .investigations_in(project.as_deref())
            .map_err(anyhow::Error::from)?,
    )
    .map_err(anyhow::Error::from)?)
}

#[command(
    name = "records",
    description = "Read INVESTIGATION records; --target DIR|FILE|URL, --kind KIND, --json"
)]
async fn records(_: (), args: RecordArgs) -> tento_sh::Result<Value> {
    let client = autophys::connect(args.target.as_deref()).map_err(anyhow::Error::from)?;
    let inv = client
        .find_investigation(&args.investigation)
        .map_err(anyhow::Error::from)?;
    Ok(serde_json::to_value(
        inv.records(args.kind.as_deref())
            .map_err(anyhow::Error::from)?,
    )
    .map_err(anyhow::Error::from)?)
}

#[command(
    name = "approve",
    description = "Approve INVESTIGATION PROPOSAL; --target DIR|FILE|URL, --by NAME, --settings JSON, --json"
)]
async fn approve(_: (), args: ApproveArgs) -> tento_sh::Result<Value> {
    let client = autophys::connect(args.target.as_deref()).map_err(anyhow::Error::from)?;
    let inv = client
        .find_investigation(&args.investigation)
        .map_err(anyhow::Error::from)?;
    Ok(serde_json::to_value(
        inv.approve(&args.proposal, &args.by, args.settings)
            .map_err(anyhow::Error::from)?,
    )
    .map_err(anyhow::Error::from)?)
}

#[command(
    name = "reject",
    description = "Reject INVESTIGATION PROPOSAL; --target DIR|FILE|URL, --by NAME, --reason TEXT, --json"
)]
async fn reject(_: (), args: RejectArgs) -> tento_sh::Result<Value> {
    let client = autophys::connect(args.target.as_deref()).map_err(anyhow::Error::from)?;
    let inv = client
        .find_investigation(&args.investigation)
        .map_err(anyhow::Error::from)?;
    Ok(serde_json::to_value(
        inv.reject(&args.proposal, &args.by, &args.reason)
            .map_err(anyhow::Error::from)?,
    )
    .map_err(anyhow::Error::from)?)
}

#[command(
    name = "verify",
    description = "Verify workbook chains and projections; --target DIR|FILE|URL, --project NAME, --json"
)]
async fn verify(_: (), args: ProjectArgs) -> tento_sh::Result<Value> {
    let client = autophys::connect(args.target.as_deref()).map_err(anyhow::Error::from)?;
    let mut reports = Vec::new();
    for wb in client.workbooks().map_err(anyhow::Error::from)? {
        if args
            .project
            .as_deref()
            .is_some_and(|project| project != wb.name() && project != wb.id())
        {
            continue;
        }
        reports.push(
            json!({"project": wb.name(), "report": wb.verify().map_err(anyhow::Error::from)?}),
        );
    }
    if args.project.is_some() && reports.is_empty() {
        return Err(anyhow::anyhow!("project not found").into());
    }
    // A failed report remains machine-readable, with a nonzero process status
    // handled by the composition root after rendering it.
    Ok(Value::Array(reports))
}

/// The embedder controls process exit codes, without the interactive shell's
/// REPL or env loading. The registry remains the single dispatch surface.
pub async fn run(mut argv: Vec<String>, out: &mut impl Write) -> u8 {
    use tento_sh::dispatch::Callable;
    let scripts = scripts();
    let json = argv.iter().any(|word| word == "--json");
    let help = argv
        .iter()
        .skip(1)
        .any(|word| matches!(word.as_str(), "--help" | "-h"))
        || argv.get(1).is_some_and(|word| word == "help");
    if argv.len() == 1 {
        eprintln!("autophys: {}", crate::USAGE);
        return 2;
    }
    if matches!(
        argv.get(1).map(String::as_str),
        Some("--version" | "version")
    ) {
        let info = crate::BuildInfo::current();
        let _ = writeln!(out, "autophys {} ({})", info.version, info.commit);
        return 0;
    }
    for (index, word) in argv.iter_mut().enumerate() {
        if word == "-h" || (index == 1 && word == "help") {
            *word = "--help".into();
        }
    }
    if help
        && argv
            .iter()
            .skip(1)
            .all(|word| matches!(word.as_str(), "--help" | "--json"))
    {
        if json {
            let _ = writeln!(out, "{}", description(&scripts));
        } else {
            let _ = writeln!(out, "{}", crate::USAGE);
            scripts.print_help(true);
        }
        return 0;
    }
    if !help
        && matches!(
            argv.get(1).map(String::as_str),
            Some("pair" | "keys" | "db")
        )
        && argv.get(2).is_none_or(|word| word.starts_with('-'))
    {
        eprintln!(
            "autophys: an admin subcommand is required\n{}",
            crate::admin::USAGE
        );
        return 2;
    }
    let result = match scripts.call_with_argv(argv.clone()) {
        Ok(future) => future.await,
        Err(error) => Err(error),
    };
    match result {
        Ok(value) => {
            let failed = argv
                .get(1)
                .is_some_and(|word| word == "verify" || word == "db")
                && value
                    .as_array()
                    .is_some_and(|rows| rows.iter().any(|row| row["report"]["ok"] != true));
            if !value.is_null() {
                if json {
                    let _ = writeln!(out, "{value}");
                } else if let Some(text) = tento_sh::run_loop::format_cli_value(&value, None) {
                    let _ = writeln!(out, "{text}");
                }
            }
            u8::from(failed)
        }
        Err(error) => {
            if let tento_sh::Error::CommandNotFound { name, .. } = &error {
                eprintln!("autophys: unknown command {name:?}\n{error}");
            } else if !error.to_string().is_empty() {
                eprintln!("autophys: {error}");
            }
            match error {
                tento_sh::Error::ArgParseError(_)
                | tento_sh::Error::MissingSubcommand(_)
                | tento_sh::Error::NoSuchSubcommand
                | tento_sh::Error::CommandNotFound { .. } => 2,
                _ => 1,
            }
        }
    }
}
