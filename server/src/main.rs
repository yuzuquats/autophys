use std::process::ExitCode;

use autophys::{BuildInfo, USAGE, app, parse_config, serve, termination};

#[tokio::main]
async fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    match args.next().as_deref() {
        Some("serve") => run_serve(args).await,
        Some("-h" | "--help" | "help") => {
            println!("{USAGE}");
            ExitCode::SUCCESS
        }
        Some("--version" | "version") => {
            let info = BuildInfo::current();
            println!("autophys {} ({})", info.version, info.commit);
            ExitCode::SUCCESS
        }
        Some(other) => {
            eprintln!("autophys: unknown command {other:?}\n{USAGE}");
            ExitCode::from(2)
        }
        None => {
            eprintln!("{USAGE}");
            ExitCode::from(2)
        }
    }
}

async fn run_serve(args: impl Iterator<Item = String>) -> ExitCode {
    let config = match parse_config(args, |k| std::env::var(k).ok()) {
        Ok(config) => config,
        Err(message) => {
            eprintln!("autophys: {message}");
            return ExitCode::from(2);
        }
    };
    let listener = match tokio::net::TcpListener::bind(config.addr).await {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("autophys: bind {}: {error}", config.addr);
            return ExitCode::FAILURE;
        }
    };
    let info = BuildInfo::current();
    eprintln!(
        "autophys {} ({}) serving {} on http://{}",
        info.version,
        info.commit,
        config.web.display(),
        listener
            .local_addr()
            .map(|a| a.to_string())
            .unwrap_or_default(),
    );
    match serve(listener, app(&config.web, info), termination()).await {
        Ok(()) => {
            eprintln!("autophys: stopped");
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("autophys: {error}");
            ExitCode::FAILURE
        }
    }
}
