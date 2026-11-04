use std::process::ExitCode;

use autophys::{
    BuildInfo, USAGE, build_web, default_web_root, parse_build_web, parse_serve, project_root, run,
};

#[tokio::main]
async fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    match args.next().as_deref() {
        Some("serve") => {
            let config = match parse_serve(args, |k| std::env::var(k).ok()) {
                Ok(config) => config,
                Err(message) => return usage_error(&message),
            };
            report(run(config).await)
        }
        Some("build-web") => {
            let out = match parse_build_web(args) {
                Ok(out) => out,
                Err(message) => return usage_error(&message),
            };
            let out = match out.map(Ok).unwrap_or_else(default_web_root) {
                Ok(out) => out,
                Err(error) => return report(Err(error)),
            };
            match build_web(project_root(), out).await {
                Ok(root) => {
                    println!("{}", root.display());
                    ExitCode::SUCCESS
                }
                Err(error) => report(Err(error)),
            }
        }
        Some(command @ ("pair" | "keys" | "db")) => {
            let command = command.to_string();
            let default = || autophys::default_db().map_err(|e| format!("{e:#}"));
            autophys::admin::run(
                &command,
                args,
                default,
                &mut std::io::stdout(),
                &mut std::io::stderr(),
            )
            .await
        }
        Some("-h" | "--help" | "help") => {
            println!("{USAGE}");
            ExitCode::SUCCESS
        }
        Some("--version" | "version") => {
            let info = BuildInfo::current();
            println!(
                "autophys {} ({}, tento {})",
                info.version, info.commit, info.tento_commit
            );
            ExitCode::SUCCESS
        }
        Some(other) => usage_error(&format!("unknown command {other:?}\n{USAGE}")),
        None => usage_error(USAGE),
    }
}

fn usage_error(message: &str) -> ExitCode {
    eprintln!("autophys: {message}");
    ExitCode::from(2)
}

fn report(result: anyhow::Result<()>) -> ExitCode {
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("autophys: {error:#}");
            ExitCode::FAILURE
        }
    }
}
