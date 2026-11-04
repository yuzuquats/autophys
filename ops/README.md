# Packaging and optional operation

`package.sh --out /absolute/path/to/new-autophys` builds a Linux single-file
executable from a clean committed checkout, with no service installation.
It uses Cargo/Deno on PATH, `strip`, and `CARGO_TARGET_DIR` (default
`${XDG_CACHE_HOME:-$HOME/.cache}/autophys/target`). Use approved external build
storage on managed hosts. Existing output is refused. The package contains
the browser payload, so consumers do not need this source checkout, Deno or
a sibling Tento installation to serve it. A source build still needs public
registry/JSR/npm/esbuild dependencies or their caches.

## Optional Linux systemd user service

`deploy.sh` is a service installer, not a test command. It builds/tests,
packages, switches the release symlink, installs `autophys.service`, restarts
it and checks health on `AUTOPHYS_ADDR` (default `127.0.0.1:4794`). Run only
when you intend to change that service. It requires systemd user services,
curl and GNU coreutils. The template lives at `systemd/autophys.service.in`.

Existing installations retain their release root at
`~/.local/share/tento/services/autophys`; a new installation may set
`AUTOPHYS_RELEASE_ROOT` to its own absolute directory. This is a local layout
compatibility default, not a dependency on a fleet daemon. Logs remain under
`~/.local/state/autophys/logs`; the service remains named `autophys.service`
and uses `Restart=on-failure`. Set `CARGO_TARGET_DIR` explicitly to keep
parallel build jobs separate. The script does not register the app in a fleet,
use SSH, or need Lona. Existing private reverse-proxy/fleet registrations live
outside this repo and are not required for standalone operation.

`check-flow.ts` is the older cookbook browser flow, kept at its existing path
for callers; current flows also live under `e2e/` and `html/e2e/`. They require
a browser and configured isolated state. Do not point a write/approval driver
at your live collection as a substitute for a test fixture.
