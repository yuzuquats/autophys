# `autophys serve` runs the vanilla cookbook skeleton from systemd, and its whole flow passes with zero errors

Status: measured on rwc-dev-01, 2026-11-04, against release `582927a`
(`~/.local/share/tento/services/autophys/582927a-20261104/`, `COMMIT`
`582927aaeeb9…`, `TENTO_COMMIT` `561cad2f55b3…`, which is the cookbook after N-1).

Screenshots are kept outside the repository in the ignored
`rwc-dev-01:~/workspace/fleet/evidence/autophys/b1-cookbook-flow-20261104T110022Z/`
(20 PNGs).

## Tests

`ops/deploy.sh` ran them before installing:

```
cargo test     src/lib.rs     test result: ok. 4 passed; 0 failed
               tests/http.rs  test result: ok. 8 passed; 0 failed
deno task test (web)          ok | 2 passed | 0 failed
deno task build               dist: index.html (Autophys), index.root.js 43.9 KiB
```

The new socket test covers the subcommand: `autophys` with no arguments and
`autophys ingest` exit 2 with usage, and `--help` exits 0. In tento,
`deno test --no-lock tento-cookbook-js/` gives `12 passed`.

## The deployed unit

```
deploy: autophys 582927a (cookbook tento 561cad2f5) healthy on 127.0.0.1:4794: {"ok":true,"version":"0.1.0","commit":"582927aaeeb9ebe3732e45a156c947eebeed94bf"}
● autophys.service - autophys serve 582927aaeeb9 (cookbook tento 561cad2f5) on 127.0.0.1:4794 (experiments/autophys)
   └─ …/582927a-20261104/bin/autophys serve --addr 127.0.0.1:4794 --web …/582927a-20261104/web
```

`curl` gives `/api/healthz` 200 with the body above, `/` 200, `/app` 200,
`/app/x` 200, `/nope` 404 and `/api/nope` 404. `systemctl --user is-active
autophys` reports `active`. The only listener on 4794 is `127.0.0.1:4794`,
owned by `autophys`.

**Restart survival.** SIGKILL went to the server's own PID, taken from
`systemctl --user show -p MainPID`:

```
before: MainPID=2305753 NRestarts=0
after:  MainPID=2306246 NRestarts=1 active=active
autophys.service: Main process exited, code=killed, status=9/KILL
autophys.service: Scheduled restart job, restart counter is at 1.
```

Healthz answered 200 again afterwards.

## The flow in a browser

`deno run -A ops/check-flow.ts http://127.0.0.1:4794 <dir>` ran against the
unit with Chromium 124 (Playwright aarch64, headless, `--no-sandbox`), first
at 1440×900 and then at 390×844 with touch. Any console error or warning,
page error, failed request or HTTP status of 400 or above fails its phase.

```review-table
| Phase | Checks | Errors | What it proves |
| ----- | ------ | ------ | -------------- |
| header | 5 | 0 | wordmark and page title read "Autophys", Open app, landing state |
| deck | 10 | 0 | 1→6 by button, cards recede while moving, ArrowLeft and Previous back, swipe 1→2 with no text left selected |
| tutorial | 13 | 0 | Open app lowers the deck to the peek at `/app`, the app mounts into `.ck-app[data-cookbook="autophys"]`, all three steps and Show me rings, Done |
| sidebar | 7 | 0 | a row pick updates main, details, breadcrumb and aria-current; the status line reads healthz |
| details | 7 | 0 | close runs FLIP and main widens by more than 200px; reopen; sidebar close and reopen |
| export | 1 | 0 | header Export saves `autophys-export.json` from `app.export()` |
| header-home | 9 | 0 | ArrowUp, wordmark home, the app unmounted with slots emptied, Back remounts and keeps the selection, ArrowDown/Up stops |
| phone | 8 | 0 | deep link opens the tutorial without moving focus, close, sidebar sheet, a pick returns to main, details sheet, Escape, Back to the deck |
```

That is 60 checks with zero errors. The orphan check from the
headless-browser skill afterwards printed no Chromium processes. The same
script against the cookbook's own demo root on scratch port 18795 (not the
unit) also passed 60 checks with zero errors; its screenshots are in
`fleet/evidence/autophys/cookbook-n1-demo-20261104T110110Z/`.

## Fleet registration

This is unchanged from rev 2: the `autophys` entry in rwc-dev-01's
`~/.config/tento/fleet/self.toml` (`127.0.0.1:4794`, `health_path =
"/api/healthz"`) still matches the unit. The URL is
`http://tento.localhost/#/rwc-dev-01/autophys`, and I have not checked it
from the laptop.
