# Run the dev Autophys server on tento-web-next

The yuzuquats dev executable can use the prebuilt route tree with the Axum adapter. The `web-next` build keeps Autophys's existing API, document and sign-in handlers. The adapter supplies the actual bound listener address for browser origin checks and the app keeps its own body limits and session cookies.

Build with `cargo build --release --locked --no-default-features --features web-next --bin autophys`. Serve an existing `--web-root` or an embedded web payload. The default `legacy-web` build retains the compiler and source watcher. The dev qualification runs the real Autophys store mount fixture under Axum, including authenticated reads, origin checks, fallback routes, and streaming.

For a single executable with all three backends, build with
`cargo build --release --locked --no-default-features --features web-next-all-backends --bin autophys`.
Set `AUTOPHYS_WEB_BACKEND` to `axum`, `actix`, or `ntex` before starting
`autophys serve`. The choice takes effect at startup. The `web-next` build
keeps Axum as its only backend and rejects a request for an unavailable backend.

[Backend profile and measurement details](http-backend-profile.md)

The November 24 follow-up vendors upstream `67e79f03c7`. Axum ends open event streams on shutdown and bounds ordinary response draining. Mutable frontend assets carry `Cache-Control: no-cache` and a weak ETag. The router reads typed numeric and boolean captures. All seven portable-router tests passed across the three adapters, and the Autophys store mount test passed with Axum.

## Source publication

On November 24, the owner fast-forwarded Autophys master through `00d92709ef487d412d54a74a4ec27167a1b27d7f` after publishing the corresponding private Tento range through `97dc6e25947b6aa814a0c41f164d2f142151e257`. Independent Codex review approved the five Autophys commits. The committed source passed the vendor verifier for 2,459 files, the Axum store mount test, and the three-backend build check. Seven unrelated drafts stayed local. The published Change-Id mapping and verification receipts are under `fleet/evidence/tento-web-next/sink-20261124/` on yuzuquats.
