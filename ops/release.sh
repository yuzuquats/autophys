#!/usr/bin/env bash
# Build this host's release archive: the packed single-file executable plus its
# license notices, as autophys-v<version>-<target>.tar.gz and a .sha256 beside it.
# Usage: ops/release.sh --out-dir /absolute/dir
# Linux packs through ops/package.sh; macOS relinks with the web app in a Mach-O
# section (`autophys pack`). Nothing is installed, published or restarted.
set -euo pipefail
if [ "$#" -ne 2 ] || [ "$1" != --out-dir ] || [[ "$2" != /* ]]; then
  echo "usage: ops/release.sh --out-dir /absolute/dir" >&2
  exit 2
fi
out_dir=$2
repo=$(cd "$(dirname "$0")/.." && pwd)
if [ -n "$(git -C "$repo" status --porcelain)" ]; then
  echo "release: commit changes first so the executable identifies its source" >&2; exit 1
fi
export PATH="$HOME/.deno/bin:$HOME/.cargo/bin:$PATH"
export CARGO_TARGET_DIR=${CARGO_TARGET_DIR:-$repo/target}
commit=$(git -C "$repo" rev-parse HEAD)
version=$(sed -n 's/^version = "\(.*\)"$/\1/p' "$repo/Cargo.toml" | head -1)
target=$(rustc -vV | sed -n 's/^host: //p')
name="autophys-v$version-$target"
archive="$out_dir/$name.tar.gz"
if [ -e "$archive" ] || [ -e "$archive.sha256" ]; then
  echo "release: output already exists: $archive" >&2; exit 2
fi
mkdir -p "$out_dir" "$CARGO_TARGET_DIR"
stage=$(mktemp -d "$CARGO_TARGET_DIR/autophys-release.XXXXXXXX")
server=
cleanup() { [ -n "$server" ] && kill "$server" 2>/dev/null; rm -rf -- "$stage"; }
trap cleanup EXIT
mkdir "$stage/$name"

case $(uname -s) in
  Linux)
    "$repo/ops/package.sh" --out "$stage/$name/autophys"
    ;;
  Darwin)
    unset TENTO_WEB
    (cd "$repo" && cargo test --workspace --locked && deno test --allow-read --config html/deno.json html/)
    (cd "$repo" && AUTOPHYS_COMMIT=$commit AUTOPHYS_RELEASE=1 cargo build --release --locked --bin autophys)
    install -m 0755 "$CARGO_TARGET_DIR/release/autophys" "$stage/autophys"
    AUTOPHYS_PROJECT_ROOT=$repo "$stage/autophys" build-web --out "$stage/web/autophys"
    # pack relinks the native binary with the ZIP in __AUTOPHYS,__web (ad-hoc signed).
    AUTOPHYS_PROJECT_ROOT=$repo "$stage/autophys" pack --web-root "$stage/web/autophys" --out "$stage/$name/autophys"
    ;;
  *) echo "release: unsupported OS $(uname -s)" >&2; exit 2 ;;
esac

cp "$repo/LICENSE-MIT" "$repo/LICENSE-APACHE" "$repo/NOTICE" "$repo/README.md" "$stage/$name/"
(cd "$repo" && python3 ops/third-party-licenses.py --target "$target" --out "$stage/$name/THIRD-PARTY-LICENSES.txt")

# Smoke: the packed file alone serves its embedded app, with isolated state.
smoke="$stage/smoke"
mkdir -p "$smoke/home"
port=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')
env -i PATH=/usr/bin:/bin HOME="$smoke/home" "$stage/$name/autophys" serve --addr "127.0.0.1:$port" \
  >"$smoke/log" 2>&1 &
server=$!
for _ in $(seq 1 100); do
  curl -fsS "http://127.0.0.1:$port/api/healthz" >"$smoke/health" 2>/dev/null && break
  sleep 0.1
done
health=$(cat "$smoke/health" 2>/dev/null || true)
page=$(curl -fsS -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/" || true)
kill "$server"; wait "$server" 2>/dev/null || true; server=
if [[ "$health" != *"\"commit\":\"$commit\""* ]] || [[ "$health" != *'"web_id"'* ]] || [ "$page" != 200 ]; then
  echo "release: smoke failed (healthz: ${health:-none}, GET / -> $page)" >&2
  cat "$smoke/log" >&2
  exit 1
fi

(cd "$stage" && COPYFILE_DISABLE=1 tar -czf "$stage/$name.tar.gz" "$name")
if command -v sha256sum >/dev/null; then sum=(sha256sum); else sum=(shasum -a 256); fi
(cd "$stage" && "${sum[@]}" "$name.tar.gz" >"$name.tar.gz.sha256")
(set -o noclobber; cat "$stage/$name.tar.gz" >"$archive"; cat "$stage/$name.tar.gz.sha256" >"$archive.sha256")
echo "release: $archive from $commit ($health)"
