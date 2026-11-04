#!/usr/bin/env bash
# Build autophys from a clean checkout at HEAD, with the tento-cookbook-js
# shell from the tento checkout's HEAD, and run it as the systemd user unit
# autophys.service (`autophys serve`) from an immutable release directory:
#
#   ~/.local/share/tento/services/autophys/<sha7>-<yyyymmdd>/{bin/autophys,web,COMMIT,TENTO_COMMIT}
#   ~/.local/share/tento/services/autophys/current -> that directory
#
# The service never runs from either checkout or a build directory.
# Usage: ops/deploy.sh   (AUTOPHYS_ADDR overrides 127.0.0.1:4794; TENTO overrides ~/workspace/tento)
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
tento=${TENTO:-$HOME/workspace/tento}
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
# The tento checkout is shared and dirty with other sessions' work; only the
# shell this app bundles has to match tento HEAD.
if [ -n "$(git -C "$tento" status --porcelain -- tento-cookbook-js)" ]; then
  echo "deploy: $tento/tento-cookbook-js differs from tento HEAD; commit it first" >&2
  exit 1
fi
commit=$(git -C "$repo" rev-parse HEAD)
tento_commit=$(git -C "$tento" rev-parse HEAD)
release_root=$HOME/.local/share/tento/services/autophys
release=$release_root/${commit:0:7}-$(date +%Y%m%d)

if [ -e "$release" ]; then
  if [ "$(cat "$release/COMMIT")" = "$commit" ] && [ "$(cat "$release/TENTO_COMMIT" 2>/dev/null)" = "$tento_commit" ]; then
    echo "deploy: $release already holds these sources; reusing it"
  else
    echo "deploy: $release exists with other sources; commit, or remove it deliberately" >&2
    exit 1
  fi
else
  (cd "$repo" && cargo test -q && AUTOPHYS_COMMIT=$commit cargo build -q --release -p autophys)
  (cd "$repo/web" && deno task test && deno task build)
  mkdir -p "$release_root"
  stage=$(mktemp -d "$release_root/.staging-XXXXXX")
  install -D -m 0755 "$CARGO_TARGET_DIR/release/autophys" "$stage/bin/autophys"
  cp -R "$repo/web/dist" "$stage/web"
  echo "$commit" > "$stage/COMMIT"
  echo "$tento_commit" > "$stage/TENTO_COMMIT"
  chmod 0755 "$stage"
  mv -T "$stage" "$release"
fi

ln -sfn "$release" "$release_root/.current.tmp"
mv -T "$release_root/.current.tmp" "$release_root/current"

mkdir -p "$HOME/.local/state/autophys/logs" "$HOME/.config/systemd/user"
unit=$HOME/.config/systemd/user/autophys.service
sed -e "s|@RELEASE@|$release|g" -e "s|@ADDR@|$addr|g" -e "s|@COMMIT@|${commit:0:12}|g" -e "s|@TENTO@|${tento_commit:0:9}|g" \
  "$repo/ops/autophys.service.in" > "$unit.tmp"
mv "$unit.tmp" "$unit"
systemctl --user daemon-reload
systemctl --user enable autophys.service
systemctl --user restart autophys.service

for _ in $(seq 1 50); do
  if body=$(curl -fsS "http://$addr/api/healthz" 2>/dev/null); then
    case "$body" in
      *"\"commit\":\"$commit\""*) echo "deploy: autophys ${commit:0:7} (cookbook tento ${tento_commit:0:9}) healthy on $addr: $body"; exit 0 ;;
    esac
  fi
  sleep 0.2
done
echo "deploy: autophys did not report commit $commit on $addr" >&2
systemctl --user --no-pager status autophys.service >&2 || true
exit 1
