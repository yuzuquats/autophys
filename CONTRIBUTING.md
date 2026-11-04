# Develop from one checkout

Use Python 3.10+, Rust with edition 2024 support (the owner currently uses
Cargo 1.98 nightly), Deno 2 (currently checked with 2.9.8), and a C toolchain
for bundled SQLite. Linux ARM64 is the current verification host. Native
macOS packaging still needs its own qualification. No fleet tool, sibling
checkout, private hostname or service registration is needed.

The license declarations currently disagree and vendored library grants are
incomplete. [The dependency notes](vendor/README.md) identify the release
blocker; these instructions do not grant redistribution permission.

## Python SDK and examples

From the repository root:

```sh
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -e './sdks/python[test]'
python -m pytest -q sdks/python/tests
```

NumPy and SciPy are required. MCP (`./sdks/python[mcp]`) and plotting are
optional; the [battery example](examples/battery_fit/README.md) installs its
own plotting environment. Python's `autophys` entry point and the Rust daemon
share a command name, so use `python -m autophys.cli` for SDK commands and an
explicit Cargo binary path for daemon commands. Pure local/scripted work needs
no model account. Provider routes require explicit configuration and keys;
replay tests do not call a provider. Cross-writer tests require
`AUTOPHYS_RUST_BIN` and `AUTOPHYS_RUST_WEB_ROOT`; without those, they skip and
must not be reported as verified.

## Daemon and browser

Choose external build storage. On the operator fleet, follow the host's approved
artifact location (SSD on multi-volume hosts); do not replace a target symlink
or use a peer's real target tree. Outside that fleet, any directory you own
outside the checkout works:

```sh
export CARGO_TARGET_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/autophys/target"
cargo test --workspace --locked
deno test --allow-read --config html/deno.json html/
deno check --config html/deno.json html/routes/index.root.ts
cargo build --locked --bin autophys
```

Cargo downloads registry crates; Deno/esbuild fetch public modules and platform
binaries on the first build. A cold build needs network access or a preseeded
cache. To refuse network use after acquisition, use `cargo --offline` and
`deno --cached-only` on the relevant subcommands. `vendor/` contains local
Tento source and patched crates, not every registry/npm/JSR dependency. There
is currently no product-owned CI workflow. `html/deno.lock` records checksums
and versions for frontend checks, optional browser drivers and the build worker.
`html/deno.json` selects frozen resolution; the Rust bundler explicitly passes
that config even though its worker runs under `vendor/`. Builds fail rather than
rewrite the lock. To prefetch the build/driver graph before offline use:

```sh
deno cache --config html/deno.json html/routes/index.root.ts \
  vendor/tento/tento-web/src/client/bundler-rpc.deno.ts \
  vendor/tento/tento-headless-js/mod.ts html/e2e/*.ts
```

The normal Deno tests acquire their own locked graph. A deliberate dependency
update uses `deno cache --frozen=false --config html/deno.json` with the affected
entrypoints, then commits the reviewed lock together with the config/import
change. esbuild's platform executable is downloaded on its first build; its
version is fixed by the integrity-checked esbuild module.

For isolated development, create a fresh writable state directory and start
the loopback daemon (this builds and watches `html/`):

```sh
lab_state=$(mktemp -d)
export TENTO_APP_CACHE_DIR="$lab_state/cache"
export TENTO_APP_DATA_DIR="$lab_state/data"
"$CARGO_TARGET_DIR/debug/autophys" serve --addr 127.0.0.1:4795 \
  --collection "$lab_state/books" --server-db "$lab_state/server.db"
```

Open `http://127.0.0.1:4795`; stop with Ctrl-C. The TENTO_APP_* names are
compatibility overrides from the vendored directory library, not a connection
to another service. With no overrides the collection is `AUTOPHYS_HOME`, else
`~/autophys`; keys/accounts use `~/.local/share/tento/autophys/server.db` and
web cache uses `~/.cache/tento/autophys` on Linux. Existing defaults remain so
an upgrade does not lose sight of server keys or workbooks. Explicit
`--collection`, `--server-db`, `--web-root` and `AUTOPHYS_PROJECT_ROOT` let an
installation choose its own locations. `TENTO_WEB` is an optional compiler
override; normally it is resolved from this checkout's `vendor/tento/tento-web`.

The server binds literal loopback IPs. A remote reverse proxy is optional and
must supply explicitly allowed browser origins/public URL; it is not part of
local development. Existing hostname fixtures test forwarded hosts and do not
contact those hosts.

## Package without installing a service

From a clean committed Linux checkout:

```sh
ops/package.sh --out /absolute/path/to/new-autophys
```

It runs Rust/browser tests, builds, bundles and packs a single executable,
refusing an existing destination. It requires the tools above plus `strip` and
never calls systemctl or changes an installed release. Python SDK checks remain
a separate gate. To inspect the native stages directly:

```sh
"$CARGO_TARGET_DIR/debug/autophys" build-web --out "$lab_state/build/web/autophys"
"$CARGO_TARGET_DIR/debug/autophys" pack \
  --web-root "$lab_state/build/web/autophys" --out "$lab_state/autophys"
```

Web output needs a dedicated empty directory: the bundler replaces it and keeps
its module store two directories above it. Strip only before packing.
`build-web`/`pack` on macOS use the platform linker/signing path; this Linux
qualification does not certify that path.

[Optional systemd deployment](ops/README.md), [Muse integration](plugins/muse-autophys/README.md)
and [training](train/sft/README.md) each have separate instructions. Browser
flow drivers require a configured Chrome binary (`AUTOPHYS_CHROME`), isolated
state and child cleanup; inspect the driver before running it. They are not
part of the pure Deno suite.
