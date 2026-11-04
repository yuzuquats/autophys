use std::process::ExitCode;

use autophys_server::{BuildInfo, app, parse_config, serve, termination};

#[tokio::main]
async fn main() -> ExitCode {
    let config = match parse_config(std::env::args().skip(1), |k| std::env::var(k).ok()) {
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
        "autophys {} ({}) listening on http://{} serving {}",
        info.version,
        info.commit,
        listener
            .local_addr()
            .map(|a| a.to_string())
            .unwrap_or_default(),
        config.web.display()
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
