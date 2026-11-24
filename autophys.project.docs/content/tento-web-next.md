# Run the dev Autophys server on tento-web-next

The yuzuquats dev executable can use the prebuilt route tree with the Axum adapter. The `web-next` build keeps Autophys's existing API, document and sign-in handlers. The adapter supplies the actual bound listener address for browser origin checks and the app keeps its own body limits and session cookies.

Build with `cargo build --release --locked --no-default-features --features web-next --bin autophys`. Serve an existing `--web-root` or an embedded web payload. The default `legacy-web` build retains the compiler and source watcher. The dev qualification runs the real Autophys store mount fixture under Axum, including authenticated reads, origin checks, fallback routes, and streaming.
