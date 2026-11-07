# Develop from one checkout

Use Python 3.10+, Rust with edition 2024 support (the owner currently uses
Cargo 1.98 nightly), Deno 2 (currently checked with 2.9.8), and a C toolchain
for bundled SQLite. Linux x86_64 is the Round 2 verification host. Native
macOS packaging still needs its own qualification. No fleet tool, sibling
checkout, private hostname or service registration is needed.

autophys is dual licensed MIT OR Apache-2.0 ([NOTICE](NOTICE)); contributions
are accepted under the same terms. [The dependency notes](vendor/README.md)
cover the vendored libraries and the parts that keep their own licenses.

## Python SDK and examples

From the repository root:

```sh
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -e './sdks/python[test]'
python -m pytest -q sdks/python/tests
```

NumPy and SciPy are required; plotting is optional, and a project made with
`autophys new` (from [examples/](examples/battery-fit/python/README.md))
installs its own plotting environment. The SDK installs no console script:
`autophys` is the Rust binary, which also runs the developer commands (`bench`,
`research`, `autoloop`, `export-trajectories` and the Muse plugin's `mcp`
server). Their tests are `cargo test --test devtools`; its tests of `mcp`
over a Python lab simulator run when `AUTOPHYS_PYTHON` (else `python3`) has
NumPy and SciPy, and skip with a message otherwise (with `CI` set, or
`AUTOPHYS_REQUIRE_PYTHON=1`, they fail instead of skipping). The Muse plugin's
protocol tests in `sdks/python/tests/test_muse_plugin.py` run with
`AUTOPHYS_RUST_BIN` set (and the `mcp` client package). Pure local/scripted work needs
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

Cargo downloads registry crates; Deno/esbuild fetch public modules and the esbuild
platform executable on the first build. `html/deno.lock` is a newly resolved
immutable graph, enforced by `html/deno.json` for checks and the actual native
bundler worker. It does not recover a historical dependency graph. The native
worker receives the product config explicitly; it does not inherit the caller's
working directory or a sibling checkout's import map.

For public cold acquisition, choose a new external `DENO_DIR` and run the
checks above. Verify the published app entry point with these frozen commands:

```sh
deno test --cached-only --frozen --allow-read --config html/deno.json html/
deno check --cached-only --frozen --config html/deno.json html/routes/index.root.ts
```

Use `cargo --offline` after Cargo acquisition and set
`AUTOPHYS_BUILD_OFFLINE=1` for native `build-web` to pass `--cached-only` to
its real worker. A frozen-lock mismatch fails rather than rewriting the lock.
Keep `DENO_DIR` and `XDG_CACHE_HOME` under owned external storage: esbuild's
platform executable is a separate runtime download/cache and is not covered
by Deno module integrity alone. Preserve its version and digest with release
qualification inputs. `vendor/` includes local source and patched crates,
not every registry/npm/JSR dependency. No product CI service is implied.

The bounded app-owned bundler patch and its source-only replay verification
are documented in [vendor/README.md](vendor/README.md). Checked-in vendor,
config and lock bytes suffice without lost workspace scripts or Git objects.

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
