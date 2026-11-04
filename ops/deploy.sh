#!/usr/bin/env bash
# Build a single-file autophys release from a clean checkout at HEAD.
# The native Linux executable carries its deflated web ZIP; strip BEFORE pack.
# Releases contain bin/autophys and COMMIT, with no accompanying web folder.
# The service never runs from the checkout or a build directory.
# Usage: ops/deploy.sh   (AUTOPHYS_ADDR overrides 127.0.0.1:4794)
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
addr=${AUTOPHYS_ADDR:-127.0.0.1:4794}
case "$addr" in
  127.*:* | "[::1]":*) ;;
  *) echo "deploy: refusing non-loopback address $addr" >&2; exit 2 ;;
esac
export PATH="$HOME/.deno/bin:$HOME/.cargo/bin:$PATH"
# rwc-dev-01 has one NVMe; build output lives in the cache, never in the checkout.
export CARGO_TARGET_DIR=${CARGO_TARGET_DIR:-$HOME/.cache/autophys/target}

if [ -n "$(git -C "$repo" status --porcelain)" ]; then
  echo "deploy: autophys working tree is not clean; commit first so the release names its source" >&2
  exit 1
fi
commit=$(git -C "$repo" rev-parse HEAD)
release_root=$HOME/.local/share/tento/services/autophys
release=$release_root/${commit:0:7}-$(date +%Y%m%d)

if [ -e "$release" ]; then
  if [ "$(cat "$release/COMMIT")" = "$commit" ]; then
    echo "deploy: $release already holds these sources; reusing it"
  else
    echo "deploy: $release exists with other sources; commit, or remove it deliberately" >&2
    exit 1
  fi
else
  (cd "$repo" && cargo test -q && deno test -q --allow-read --permit-no-files html/)
  (cd "$repo" && AUTOPHYS_COMMIT=$commit AUTOPHYS_RELEASE=1 cargo build -q --release --locked --bin autophys)
  mkdir -p "$release_root"
  stage=$(mktemp -d "$release_root/.staging-XXXXXX")
  mkdir -p "$stage/.build" "$stage/bin"
  install -m 0755 "$CARGO_TARGET_DIR/release/autophys" "$stage/.build/autophys"
  strip "$stage/.build/autophys"
  # build-web fails when build-status.json reports bundle errors.
  AUTOPHYS_PROJECT_ROOT=$repo "$stage/.build/autophys" build-web --out "$stage/.build/web/autophys" >/dev/null
  test -f "$stage/.build/web/autophys/routes/index.anon.html" && test -f "$stage/.build/web/autophys/routes/index.root.js"
  "$stage/.build/autophys" pack --web-root "$stage/.build/web/autophys" --out "$stage/bin/autophys"
  rm -rf -- "$stage/.build"
  echo "$commit" > "$stage/COMMIT"
  chmod 0755 "$stage"
  mv -T "$stage" "$release"
fi

ln -sfn "$release" "$release_root/.current.tmp"
mv -T "$release_root/.current.tmp" "$release_root/current"

mkdir -p "$HOME/.local/state/autophys/logs" "$HOME/.config/systemd/user"
unit=$HOME/.config/systemd/user/autophys.service
sed -e "s|@RELEASE@|$release|g" -e "s|@ADDR@|$addr|g" -e "s|@COMMIT@|${commit:0:12}|g" \
  "$repo/ops/autophys.service.in" > "$unit.tmp"
mv "$unit.tmp" "$unit"
systemctl --user daemon-reload
systemctl --user enable autophys.service
systemctl --user restart autophys.service

for _ in $(seq 1 50); do
  if body=$(curl -fsS "http://$addr/api/healthz" 2>/dev/null); then
    case "$body" in
      *"\"commit\":\"$commit\""*) echo "deploy: autophys ${commit:0:7} healthy on $addr: $body"; exit 0 ;;
    esac
  fi
  sleep 0.2
done
echo "deploy: autophys did not report commit $commit on $addr" >&2
systemctl --user --no-pager status autophys.service >&2 || true
exit 1
