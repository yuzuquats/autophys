# autophys is a daemon that serves the tento cookbook shell, and grows from there

Status: rev 4 (2026-11-04). The repo is restructured per the operator's
S-1..S-3 rulings ([repo.md](repo.md)): one root crate on tento-web's
file-based router, `html/` holding the routes, ui and client, and a vendored
tento tree at `vendor/tento`. The deployed unit still runs the batch-1
release until the store lands and the orchestrator redeploys. Rev 3's text
below is kept as the batch-1 record; "Shape after the restructure" and
[decisions.md](decisions.md) supersede it where they differ.

Pages: [decisions.md](decisions.md) (operator rulings and pending agent
choices), [repo.md](repo.md) and [architecture.md](architecture.md) (moved
from tento's record, unchanged), [tento-plan.md](tento-plan.md) (tento's
cover, moved and renamed), [sdk.md](sdk.md), [display-manifest.md](display-manifest.md) (the plan to make the UI generic), and the batch-1 verification
pages.

## Shape after the restructure

```
Cargo.toml  Cargo.lock    package and bin `autophys`; tento-web and tento-dirs from vendor/tento
src/app.rs                DomainConfig: compiler deps (html, vendored cookbook and tento-ui), /api/healthz,
                          the /api/v1 hook, /app document routes
src/server.rs             loopback refusal, serve (dev build + watch, or --web-root), build-web
html/routes/              index.anon.html + index.root.ts (the composition root) + content.ts
html/ui/  html/client/    imported from tento-autophys-js (tento 645a1155c)
html/tsconfig.json        esbuild aliases into vendor/tento; html/deno.json the same for deno test
e2e/approve.ts            serve on 4795, deck -> app -> proposal -> Approve, headless
ops/                      deploy.sh (build-web + release build, serve --web-root), unit template
vendor/                   hackathon/lib's vendored tento tree
sdks/python/              the SDK (sdk.md)
```

The operator asked on 2026-11-04 to rebuild the app from first principles in
a new repository, autophys, on rwc-dev-01: in batches, skeleton first, then
registered to the fleet. They named it a new physics app, then narrowed batch
1 to "purely a skeleton ... containing the sidebar, header, details, tutorial
and pitch deck", flowing seamlessly, and nothing else: no physics and nothing
from light-scatter. Later the same day they placed the pieces:

- the reusable shell is **`tento/tento-cookbook-js`**, with no autophys
  content (tento project `tento-cookbook`);
- **this repository** is the Rust crate. Its binary `autophys` has a `serve`
  subcommand that serves the miniapp. It also owns the composition: `web/`
  imports the cookbook from the tento checkout and fills the slots;
- for now the app autophys serves **is** the vanilla cookbook skeleton, with
  `id "autophys"` and `title "Autophys"`, and slots holding neutral
  placeholder rows, text and status. It imports nothing from
  `tento-autophys-js`, another agent's package, and is the basis to iterate
  on;
- the cookbook's public API is one `Cookbook` namespace (N-1).

So this repository no longer carries a copy of the shell. Rev 2's client
(`web/src/*.ts`, `style.css`) was pulled into tento-cookbook-js and removed
here by a forward commit; the history keeps it.

## Shape

```review-flow
flowchart LR
  T[vendor/tento/tento-cookbook-js\nCookbook namespace] -->|import @tento-cookbook\nhtml/deno.json import map| R[html/routes/index.root.ts\nCookbook.mount.run AutophysApp]
  R -->|tento-cookbook-js/build.ts| D[web/dist: index.html + index.root.js]
  D -->|ops/deploy.sh| W[release web/]
  S[server/: autophys serve\n127.0.0.1:4794] -->|static + /api/healthz| W
  U[autophys.service] --> S
  F[fleet self.toml id autophys] --> L[laptop tento.localhost]
  class R,S changed
  class T new
```

- `server/`: crate `autophys`, binary `autophys`. `autophys serve --web <dir>
  [--addr 127.0.0.1:4794]` refuses any address that is not a literal loopback
  IP, serves `GET /api/healthz` as `{"ok":true,"version":…,"commit":…}`,
  answers `/` and `/app/...` with `index.html`, serves the bundle as static
  files, returns 404 for anything else (JSON under `/api/`), and drains on
  SIGTERM. With no subcommand, or an unknown one, it exits 2 with usage.
  The daemon will later ingest SDK events and own a database. Only `serve`
  exists now.
- `web/`: `src/app.ts` is `AutophysApp`, the cookbook's `PlaceholderApp` with
  autophys's id and title, and `src/index.root.ts` runs it with
  `Cookbook.mount().run(...)`. `deno task build` bundles it with
  `tento-cookbook-js/build.ts` into the ignored `web/dist/`.
- `ops/`: `deploy.sh` requires a clean autophys tree and a
  `tento-cookbook-js` that matches tento HEAD. It installs into
  `~/.local/share/tento/services/autophys/<sha7>-<yyyymmdd>/` and records
  `COMMIT` and `TENTO_COMMIT`. It repoints `current`, renders
  `autophys.service` with `ExecStart=… bin/autophys serve …`, and waits for
  healthz. `check-flow.ts` drives the whole flow in headless Chrome.

Build output stays in `CARGO_TARGET_DIR=$HOME/.cache/autophys/target`; no
checkout has a real `target/`.

## Batches

```review-table
| Batch | Content | State |
| ----- | ------- | ----- |
| B1 | `autophys serve` + the vanilla cookbook skeleton (sidebar, header, details, tutorial, pitch deck, seamless flow), systemd unit, fleet registration | implemented |
| B2 | generic workbench: the display manifest (DM-1): simulators declare channels, settings and views; `PUT /projects/{pid}/display` outside the config hash; one UI renders any product. Python SDK (autophys/py), daemon and Rust SDK (autophys/rs), UI (autophys/ui) | planned (PURPOSE, operator 2026-11-04) |
```

## Decisions

```review-table
| Id | Decision | Who | Reason / alternative | Reversal cost |
| -- | -------- | --- | -------------------- | ------------- |
| AP-1 (revised) | shell in `tento/tento-cookbook-js`; this repo is the `autophys` crate (`autophys serve`, axum) and owns the composition; no `tento/tento-autophys` crate in this batch | **operator, 2026-11-04** | supersedes the agent-chosen "standalone repo, crates.io axum, no tento" | n/a: operator ruling |
| AP-2 | repo stays at `~/workspace/experiments/autophys`, branch master, no remote | superseded by S-1 (operator, 2026-11-04): `~/workspace/autophys`, a workspace submodule with a private remote | the ignored home for unpublished miniapps | n/a: superseded |
| AP-3 | port `127.0.0.1:4794` | agent-chosen, pending operator review | free in the 47xx block next to hacks-inference (4790) on 2026-11-04 | edit deploy default and self.toml |
| AP-4 | `Restart=on-failure` | agent-chosen, pending operator review | a crash restarts and a deliberate stop stays stopped; the alternative is `always` | one line in the unit template |
| AP-6 | the app is the cookbook's PlaceholderApp with autophys's id and title | **operator, 2026-11-04** | "for now the app that autophys serves is the vanilla tento-cookbook-js skeleton" | replace `web/src/app.ts` |
| AP-8 | the client imports the cookbook through the `@tento-cookbook` alias in `html/deno.json` and `html/tsconfig.json`, which resolves to `vendor/tento/tento-cookbook-js` | agent-chosen, pending operator review | the bundle is built from the vendored tree, and the release records the vendored tree id | edit one import-map line |
```

The rev 2 decisions AP-5 (plain TypeScript shell) and AP-7 (`ck-` prefix)
moved with the shell and are CB-1 and CB-2 in
`tento/projects/tento-cookbook.project.docs`.

## Validation

`cargo test` (server), `deno task test` (web) and `deno task build`. On the
redeployed unit: `curl /api/healthz`, `systemctl --user is-active
autophys`, a SIGKILL of the server PID with systemd restarting it, and
`ops/check-flow.ts` through header, deck, tutorial, sidebar, details, header
Export, return home and a phone viewport, with zero console, page or
network errors. Results: [verification-b1.md](verification-b1.md) for the
rev 2 release (`ac0a7b1`), [verification-b1-cookbook.md](verification-b1-cookbook.md)
for this one.

## Purpose (operator, 2026-11-04)

```review-callout
kind: decision
title: PURPOSE: a general physics-investigation workbench
autophys is a general physics-investigation workbench, not a
battery-calibration product. Battery is one example domain beside
oscillator and thermal_rc. B2 planning is unblocked on that basis and
includes the generic display manifest (DM-1, [display-manifest.md](display-manifest.md)).
Recorded in [decisions.md](decisions.md).
```

## Remaining work

- Restructure follow-ups (2026-11-04): redeploy with `ops/deploy.sh` once
  the store lands (the unit still runs release 582927a); remove
  `tento-autophys-js` and the moved record pages from tento (S-3, the
  orchestrator's); fill in O-3 in decisions.md; replace deploy's tento pin
  with the vendored tree id. The dev watch (tento-web `watch_dev`) was
  checked once: an edit to html/routes/content.ts rebuilt the served bundle.
- B2 (display manifest, DM-1): see [display-manifest.md](display-manifest.md). AP-3, AP-4 and AP-8 were confirmed on 2026-11-04 (decisions.md).
- Confirm `http://tento.localhost/#/rwc-dev-01/autophys` from the laptop
  after its next registry refresh.
- Task board: unavailable on rwc-dev-01 (no `lona task` CLI and no
  `~/.tento-tasks` board); the steps live in these pages.

## Scope boundary

This repository owns `server/`, `web/`, `ops/`, this record,
`autophys.service`, `~/.local/share/tento/services/autophys/`,
`~/.local/state/autophys/`, `~/.cache/autophys/`,
and the `autophys` entry in
rwc-dev-01's fleet `self.toml`. It reads `tento-cookbook-js` and writes
nothing in tento. `tento-autophys-js` is not imported.
