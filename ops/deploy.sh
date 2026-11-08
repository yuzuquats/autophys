#!/usr/bin/env bash
# Build a single-file autophys release from a clean checkout at HEAD.
# The native Linux executable carries its deflated web ZIP; strip BEFORE pack.
# Releases contain bin/autophys and COMMIT, with no accompanying web folder.
# The service never runs from the checkout or a build directory.
# Usage: ops/deploy.sh   (AUTOPHYS_ADDR overrides 127.0.0.1:4794)
set -euo pipefail
# The validation patterns below mean ASCII; in a UTF-8 locale bash's [A-Za-z]
# also matches letters such as é, which would reach sed and systemd.
export LC_ALL=C

repo=$(cd "$(dirname "$0")/.." && pwd)
addr=${AUTOPHYS_ADDR:-127.0.0.1:4794}
# The address also lands in the unit file through sed, so accept only a
# loopback IP and a port: nothing else can reach the substitution.
if ! [[ "$addr" =~ ^(127\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}|\[::1\]):[0-9]{1,5}$ ]]; then
  echo "deploy: refusing non-loopback address $addr" >&2; exit 2
fi
export PATH="$HOME/.deno/bin:$HOME/.cargo/bin:$PATH"
# One build cache: the checkout's own (gitignored) target/, unless overridden.
export CARGO_TARGET_DIR=${CARGO_TARGET_DIR:-$repo/target}
# A release bundles with the tento-web in vendor/, never one TENTO_WEB names.
unset TENTO_WEB

if [ -n "$(git -C "$repo" status --porcelain)" ]; then
  echo "deploy: autophys working tree is not clean; commit first so the release names its source" >&2
  exit 1
fi
commit=$(git -C "$repo" rev-parse HEAD)
release_root=${AUTOPHYS_RELEASE_ROOT:-$HOME/.local/share/tento/services/autophys}
# This literal is used by both sed and systemd (ExecStart/WorkingDirectory).
# Validate before building, installing, or switching current. Keep the grammar
# deliberately small instead of applying one escaping rule to two parsers.
if ! [[ "$release_root" =~ ^/[A-Za-z0-9_./-]+$ ]]; then
  echo "deploy: AUTOPHYS_RELEASE_ROOT must be absolute and use only ASCII letters, digits, _, ., / and -" >&2; exit 2
fi
release=$release_root/${commit:0:7}-$(date +%Y%m%d)

if [ -e "$release" ]; then
  if [ "$(cat "$release/COMMIT")" = "$commit" ]; then
    echo "deploy: $release already holds these sources; reusing it"
  else
    echo "deploy: $release exists with other sources; commit, or remove it deliberately" >&2
    exit 1
  fi
else
  (cd "$repo" && cargo test -q --workspace --locked && deno test -q --allow-read --config html/deno.json html/)
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
  "$repo/ops/systemd/autophys.service.in" > "$unit.tmp"
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
