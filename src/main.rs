use std::process::ExitCode;

use autophys_cli::{
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
            let (args, bundle) = match autophys_cli::embedded::parse_bundle(args) {
                Ok(parsed) => parsed,
                Err(message) => return usage_error(&message),
            };
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
                    if let Some(bundle) = bundle {
                        let packed = std::env::current_exe()
                            .map_err(anyhow::Error::from)
                            .and_then(|exe| {
                                autophys_cli::embedded::pack(&exe, &root, &bundle, true)
                            });
                        return report(packed);
                    }
                    println!("{}", root.display());
                    ExitCode::SUCCESS
                }
                Err(error) => report(Err(error)),
            }
        }
        Some("pack") => {
            let args = match autophys_cli::embedded::parse_pack(args) {
                Ok(args) => args,
                Err(message) => return usage_error(&message),
            };
            report(
                std::env::current_exe()
                    .map_err(anyhow::Error::from)
                    .and_then(|exe| {
                        autophys_cli::embedded::pack(
                            &exe,
                            &args.web_root,
                            &args.out,
                            args.with_maps,
                        )
                    }),
            )
        }
        Some(command @ ("pair" | "keys" | "db")) => {
            let command = command.to_string();
            let defaults = autophys_cli::admin::Defaults {
                collection: autophys_cli::default_collection(),
                server_db: match std::env::var_os("AUTOPHYS_SERVER_DB")
                    .map(std::path::PathBuf::from)
                {
                    Some(path) => path,
                    None => match autophys_cli::default_server_db() {
                        Ok(path) => path,
                        Err(error) => return report(Err(error)),
                    },
                },
            };
            autophys_cli::admin::run(
                &command,
                args,
                defaults,
                &mut std::io::stdout(),
                &mut std::io::stderr(),
            )
        }
        Some("-h" | "--help" | "help") => {
            println!("{USAGE}");
            ExitCode::SUCCESS
        }
        Some("--version" | "version") => {
            let info = BuildInfo::current();
            println!("autophys {} ({})", info.version, info.commit);
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
