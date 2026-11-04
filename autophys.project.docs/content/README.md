# autophys starts as a running skeleton, and grows only by pieces it needs

Status: plan rev 1. Batch 1 (skeleton) is implemented on rwc-dev-01; batches
2 and later are proposals waiting for operator direction.

The operator asked, on 2026-11-04, to "rebuild the app from first principles",
pulling pieces slowly into a new repository called autophys on rwc-dev-01,
built in batches so the skeleton exists and runs first, then registered to the
fleet. They clarified that autophys is **a new physics app**. They have not
described what it does beyond that, and this plan does not guess: batch 1
contains no physics and no product features, only the frame a physics app
needs before its first piece arrives.

This project changes nothing outside its own repository, its own systemd user
unit, its own release directory and one appended entry in rwc-dev-01's fleet
self-declaration. It does not touch hacks-site, its mirror, its services, or
the light-scatter repository; those are read-only sources of future pieces.

## The rule that makes this a rebuild

The reason to start a new repository instead of continuing in hacks-site is
that the older tree accumulated fleet couplings (vendored tento crates, shared
design-system packages, inference gateways, deployment scripts tied to other
hosts) that a new physics app does not need on day one. Copying the tree would
carry all of them; starting empty carries none. So:

```review-callout
decision
A piece is pulled only when the current batch needs it. It is read in its
source, rewritten or trimmed to what autophys uses, and committed here with a
note naming its origin (repo, path, commit). Nothing is bulk-copied, and no
piece arrives with a dependency on another fleet tree unless that dependency
is itself the decision being made.
```

## Shape after batch 1

```review-flow
flowchart LR
  B[browser] -->|GET /| S[autophys-server 127.0.0.1:4794]
  B -->|GET /api/healthz| S
  S -->|static files| D[release dir web/]
  U[systemd --user autophys.service] -->|ExecStart, Restart=on-failure| S
  F[~/.config/tento/fleet/self.toml] -->|id autophys| L[laptop tento.localhost]
  L -->|proxy| S
  class S,D,U new
  class F changed
```

- `server/` — one Rust binary crate (`autophys-server`), crates.io
  dependencies only: tokio, axum, tower-http, serde/serde_json. It refuses any
  `--addr` that is not a literal loopback IP, serves `GET /api/healthz` as
  `{"ok":true,"version":…,"commit":…}`, serves the built client as static
  files, answers unknown paths with 404 (JSON under `/api/`), and drains on
  SIGTERM.
- `web/` — a TypeScript client bundled by `deno bundle` (Deno's built-in
  esbuild) into `web/dist/`, which is ignored. The page is the title, a canvas
  where physics will render (a placeholder grid for now), and a status line
  read from `/api/healthz`.
- `ops/` — `deploy.sh` builds from a clean tree, installs the binary and
  client into `~/.local/share/tento/services/autophys/<sha7>-<yyyymmdd>/`,
  repoints `current`, writes `autophys.service` from `ops/autophys.service.in`
  and restarts it. The service never runs from a checkout build directory.

Build output goes to `CARGO_TARGET_DIR=$HOME/.cache/autophys/target`; the
checkout never has a real `target/`. rwc-dev-01 has one NVMe and no external
build volume; the operator asked for this app to be built here.

## Batches

```review-table
| Batch | Content                                                        | State                         |
| ----- | -------------------------------------------------------------- | ----------------------------- |
| B1    | repo, plan, loopback server, healthz, static client, systemd unit, fleet registration | implemented |
| B2    | app shell and design pieces from the hacks-site client (layout, type, colour tokens), rewritten without the shared design-system package | proposal, pending operator direction |
| B3    | first physics core pulled from light-scatter (a renderer or simulation step chosen once the product question below is answered) | proposal, pending operator direction |
| B4    | further pieces, each justified by a concrete need of the app   | proposal, pending operator direction |
```

B2 and later are listed so a reviewer can see where the skeleton is going; none
of them is authorised by this plan, and their order may change once the
operator says what the app is for.

## Decisions

Each of these is **agent-chosen, pending operator review**. Silence is not
confirmation.

```review-table
| Id   | Before → after | Why | Strongest alternative and tradeoff | Reversal cost |
| ---- | -------------- | --- | ---------------------------------- | ------------- |
| AP-1 | no server → crates.io axum + tower-http server, no tento vendoring | smallest dependency set that serves static files and JSON with graceful shutdown; keeps the rebuild free of fleet couplings | tento-web per the miniapp ring-2 contract: shared conventions and helpers, but pulls a tento checkout or vendored crates into batch 1 | swap the HTTP layer in `server/src/lib.rs`; small now (one router, three handlers) and grows with every route |
| AP-2 | no repo → standalone repo at `~/workspace/experiments/autophys`, branch master, no remote | experiments/ is the workspace's ignored home for unpublished miniapps; nothing else has to change on any host | a workspace root app or submodule: visible on every development host, but needs a workspace master inventory change (D53) on all hosts | move the directory and add it to the root inventory; cheap while there is no remote and no caller but the unit |
| AP-3 | no port → `127.0.0.1:4794` | free in the 47xx block next to hacks-inference (4790): not listening (`ss -ltn`) and not declared in rwc-dev-01 self.toml or any user unit on 2026-11-04 | another free 47xx port | edit `ops/autophys.service.in` default and the self.toml entry, redeploy |
| AP-4 | — → `Restart=on-failure` | a crash (non-zero exit or SIGKILL) restarts; a deliberate SIGTERM stop stays stopped | `Restart=always`, as hacks-site uses: also restarts after a clean stop | one line in the unit template |
```

## Validation

Batch 1 is checked by `cargo test` (healthz body, static index and assets, 404
on missing static and unknown `/api/` paths, loopback acceptance and refusal,
the binary exiting non-zero on `--addr 0.0.0.0:…`, and graceful shutdown of a
served listener), `deno task test` for the client's status-line logic,
`deno task build`, and on the deployed unit: `curl` of `/api/healthz` through
the systemd service, `systemctl --user is-active autophys`, and a SIGKILL of
the server PID (by PID) followed by systemd restarting it. The measured results
are recorded in [verification-b1.md](verification-b1.md).

## Open question for the operator

```review-callout
note
What is autophys for? "A new physics app" names the domain, not the product:
it could be an interactive simulation, a renderer for light-scatter's
reconstructions, a teaching tool, or something else. B2 and B3 cannot be
ordered or scoped until this is answered, so they stay proposals.
```

## Remaining work

- Operator answer to the product question above, then direction on B2+.
- Operator review of AP-1..AP-4.
- Task board: unavailable on rwc-dev-01 (no `lona task` CLI installed and no
  `~/.tento-tasks` board on this host); the B1 steps and their states are
  recorded in this page and in the verification page instead.

## Scope boundary

This project owns `~/workspace/experiments/autophys`, the
`autophys.service` user unit, `~/.local/share/tento/services/autophys/`,
`~/.local/state/autophys/`, `~/.cache/autophys/` and the `autophys` entry in
rwc-dev-01's `~/.config/tento/fleet/self.toml`. hacks-site (owner
yuzuquats) and light-scatter are read-only sources here.
