use std::process::ExitCode;

#[tokio::main]
async fn main() -> ExitCode {
    // The tree is constructed without reading config. Help/reflection works
    // with an empty environment; commands load their own configuration.
    ExitCode::from(
        autophys_cli::scripts::run(std::env::args().collect(), &mut std::io::stdout()).await,
    )
}
