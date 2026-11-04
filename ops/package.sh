#!/usr/bin/env bash
# Build a Linux single-file executable without installing or restarting a service.
# Usage: ops/package.sh --out /absolute/path/to/new-autophys
set -euo pipefail
if [ "$#" -ne 2 ] || [ "$1" != --out ] || [[ "$2" != /* ]]; then
  echo "usage: ops/package.sh --out /absolute/path/to/new-autophys" >&2
  exit 2
fi
out=$2
if [ -e "$out" ] || [ -L "$out" ]; then
  echo "package: output already exists: $out" >&2; exit 2
fi
if [ "$(uname -s)" != Linux ]; then
  echo "package: this script qualifies Linux; see CONTRIBUTING.md for native pack commands" >&2; exit 2
fi
repo=$(cd "$(dirname "$0")/.." && pwd)
if [ -n "$(git -C "$repo" status --porcelain)" ]; then
  echo "package: commit changes first so the executable identifies its source" >&2; exit 1
fi
commit=$(git -C "$repo" rev-parse HEAD)
export CARGO_TARGET_DIR=${CARGO_TARGET_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/autophys/target}
# Always bundle the vendored compiler, independently of host environment overrides.
unset TENTO_WEB
(cd "$repo" && cargo test --workspace --locked && deno test --allow-read --config html/deno.json html/)
(cd "$repo" && AUTOPHYS_COMMIT=$commit AUTOPHYS_RELEASE=1 cargo build --release --locked --bin autophys)
# Only this private staging directory is removed. The destination is created last.
stage=$(mktemp -d "$CARGO_TARGET_DIR/autophys-package.XXXXXXXX")
trap 'rm -rf -- "$stage"' EXIT
install -m 0755 "$CARGO_TARGET_DIR/release/autophys" "$stage/autophys"
strip "$stage/autophys"
AUTOPHYS_PROJECT_ROOT=$repo "$stage/autophys" build-web --out "$stage/web/autophys"
"$stage/autophys" pack --web-root "$stage/web/autophys" --out "$stage/packed-autophys"
# Do not replace an existing destination, including one created during the build.
# noclobber reserves it atomically; cat preserves the packed bytes (no post-pack strip).
(set -o noclobber; cat "$stage/packed-autophys" > "$out")
chmod 0755 "$out"
echo "package: $out from $commit"
