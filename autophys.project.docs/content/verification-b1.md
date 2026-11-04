# Batch 1 runs from systemd, answers healthz, and its whole flow passes with zero errors

Status: measured on rwc-dev-01, 2026-11-04, against release `ac0a7b1`
(`~/.local/share/tento/services/autophys/ac0a7b1-20261104/`).

Every number below comes from a command shown with it. Screenshots are kept
outside the repository in the ignored
`rwc-dev-01:~/workspace/fleet/evidence/autophys/b1-flow-20261104T103849Z/`
(20 PNGs); the file names below are theirs.

## Tests

`CARGO_TARGET_DIR=$HOME/.cache/autophys/target cargo test`:

```
running 4 tests   (src/lib.rs)   test result: ok. 4 passed; 0 failed
running 7 tests   (tests/http.rs) test result: ok. 7 passed; 0 failed
```

The seven socket tests cover the healthz body and content type, static
`text/html`, `javascript` and `text/css`, `/app` and `/app/<item>` serving
the document, 404 for missing files, `/api/nope` (JSON) and `/api`, a
`/../` traversal staying inside the web root, graceful drain on the shutdown
signal, the binary exiting 2 with "not loopback" for `0.0.0.0:0`, `[::]:0`
and `100.64.0.19:0`, and the binary exiting 0 on SIGTERM. `cargo clippy
--all-targets` reports nothing.

`deno task test` (in `web/`): `ok | 9 passed | 0 failed`. `deno task build`:
`web/dist: main.js 20.4 KiB, style.css 20.7 KiB, index.html`, after
`deno check` passes.

## The deployed unit

`ops/deploy.sh` ended with:

```
deploy: autophys ac0a7b1 healthy on 127.0.0.1:4794: {"ok":true,"version":"0.1.0","commit":"ac0a7b1e5a1c6d4ffaa6c975d7f09053f59ead92"}
```

`curl -sS -w "HTTP %{http_code}" http://127.0.0.1:4794/api/healthz` →
`HTTP 200`, same body. `/` 200, `/app/untitled-2` 200, `/nope` 404,
`/api/nope` 404 with `{"error":"not found","ok":false,"path":"/api/nope"}`.

`systemctl --user is-active autophys` → `active`. `ss -ltnp` shows the only
listener on 4794 is `127.0.0.1:4794` owned by `autophys-server`, and the
process runs from the release directory, not the checkout:

```
/home/james/.local/share/tento/services/autophys/ac0a7b1-20261104/bin/autophys-server --addr 127.0.0.1:4794 --web /home/james/.local/share/tento/services/autophys/ac0a7b1-20261104/web
```

**Restart survival.** The server's own PID was killed with SIGKILL (by PID,
from `systemctl --user show -p MainPID`); systemd started a new one:

```
before: MainPID=2230368 NRestarts=0
after:  MainPID=2230959 NRestarts=1 active=active
autophys.service: Main process exited, code=killed, status=9/KILL
autophys.service: Scheduled restart job, restart counter is at 1.
```

and healthz answered 200 again.

## The flow in a browser

`deno run -A ops/check-flow.ts http://127.0.0.1:4794 <dir>` against the
systemd service, Chromium 124 (Playwright aarch64 build, headless,
`--no-sandbox` because this host's AppArmor blocks unprivileged user
namespaces), 1440×900 then 390×844 touch. Any console error or warning,
page error, failed request or HTTP status ≥ 400 fails its phase.

```review-table
| Phase       | Checks | Errors | What it proves | Screenshots |
| ----------- | ------ | ------ | -------------- | ----------- |
| header      | 4  | 0 | wordmark, "Open app", landing state | 01 |
| deck        | 9  | 0 | 1→6 by button, cards recede while moving and refill when settled, Next disabled on 6, ArrowLeft and Previous step back, mouse swipe left moves 1→2 | 02, 03, 04 |
| tutorial    | 12 | 0 | Open app lowers the deck to the peek, URL `/app/untitled-1`, header app state and breadcrumb, all three steps, Show me rings sidebar list, details toggle and wordmark, Done lowers the peek away | 05–10 |
| sidebar     | 8  | 0 | selecting moves URL, main title, details, breadcrumb and aria-current; status line reads healthz | 11, 12 |
| details     | 7  | 0 | details close runs FLIP animations, main widens by more than 200px, reopen, sidebar close and reopen | 13, 14, 15 |
| header-home | 7  | 0 | ArrowUp raises the peek, wordmark returns to the deck at `/`, Back reopens the same item, ArrowDown/ArrowUp walk all three stops | 16 |
| phone       | 8  | 0 | deep link `/app/untitled-2` opens with the tutorial, close dismisses it, sidebar sheet, select returns to main, details sheet, Escape closes it, Back from the deep link lands on the deck | 17–20 |
```

After the run, the orphan check from the headless-browser skill printed no
Chromium processes.

Two defects found by earlier runs of the same check were fixed before this
one: a mouse swipe left deck text selected (now cleared, and the track is
unselectable while dragging), and a deep link showed a focus ring on the
wordmark (focus now moves to the wordmark only when it was on the deck or
header link that went inert).

## Fleet registration

Preimage `~/.local/state/autophys/self.toml.preimage-20261104T103827Z`
(sha256 `88a466ef…7278`, identical to the file before the edit). The edit
appends one entry; `diff -u` shows only additions after the last line:

```
+# ring 2: bespoke frontend, own Rust server; autophys repo experiments/autophys
+# systemd user unit autophys.service, release ~/.local/share/tento/services/autophys/current.
+[[services.wrapped]]
+id = "autophys"
+addr = "127.0.0.1:4794"
+health_path = "/api/healthz"
```

Python `tomllib` parses the result: 17 `services.wrapped` entries, ids and
addresses unique, only top-level key `services` (this file has no `[iroh]`
block). Laptop URL: `http://tento.localhost/#/rwc-dev-01/autophys`, live
after the laptop's next registry refresh; not checked from the laptop.
