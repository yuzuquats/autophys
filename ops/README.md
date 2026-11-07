# Packaging and optional operation

`package.sh --out /absolute/path/to/new-autophys` builds a Linux single-file
executable from a clean committed checkout, with no service installation.
It uses Cargo/Deno on PATH, `strip`, and `CARGO_TARGET_DIR` (default
`${XDG_CACHE_HOME:-$HOME/.cache}/autophys/target`). Use approved external build
storage on managed hosts. Existing output is refused. The package contains
the browser payload, so consumers do not need this source checkout, Deno or
a sibling Tento installation to serve it. A source build still needs public
registry/JSR/npm/esbuild dependencies or their caches.

## Release archives

`release.sh --out-dir /absolute/dir` builds this host's
`autophys-v<version>-<target>.tar.gz` and a `.sha256` beside it, from a clean
committed checkout. It runs the same tests as `package.sh`, packs the single
executable (Linux through `package.sh`; macOS relinks with the web ZIP in the
`__AUTOPHYS,__web` section), and adds `LICENSE-MIT`, `LICENSE-APACHE`,
`NOTICE`, `README.md` and `THIRD-PARTY-LICENSES.txt`. That last file comes from
`third-party-licenses.py`, which walks the locked Cargo graph for the target and
copies each third-party crate's license files, then appends
`licenses/web-editors.txt`. Before archiving, the script serves the packed file
alone with an empty HOME and checks `/api/healthz` reports this commit and an
embedded `web_id`. It publishes nothing; upload the archives to a GitHub
release from a tag on the same commit.

## Optional Linux systemd user service

`deploy.sh` is a service installer, not a test command. It builds/tests,
packages, switches the release symlink, installs `autophys.service`, restarts
it and checks health on `AUTOPHYS_ADDR` (default `127.0.0.1:4794`). Run only
when you intend to change that service. It requires systemd user services,
curl and GNU coreutils. The template lives at `systemd/autophys.service.in`.

Existing installations retain their release root at
`~/.local/share/tento/services/autophys`; a new installation may set
`AUTOPHYS_RELEASE_ROOT` to its own absolute directory using only ASCII letters,
digits, `_`, `.`, `/` and `-`. Spaces, backslashes, percent signs, quotes and
control characters are rejected before build/install/symlink changes, because
the path is a literal in both sed and systemd syntax. This is a local layout
compatibility default, not a dependency on a fleet daemon. Logs remain under
`~/.local/state/autophys/logs`; the service remains named `autophys.service`
and uses `Restart=on-failure`. Set `CARGO_TARGET_DIR` explicitly to keep
parallel build jobs separate. The script does not register the app in a fleet,
use SSH, or need Lona. Existing private reverse-proxy/fleet registrations live
outside this repo and are not required for standalone operation.

`check-flow.ts` is the older cookbook browser flow, kept at its existing path
for callers; current flows also live under `tests/e2e/`. They require
a browser and configured isolated state. Do not point a write/approval driver
at your live collection as a substitute for a test fixture.
