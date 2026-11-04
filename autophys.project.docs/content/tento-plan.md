# autophys becomes two tento packages: a reusable app shell and a daemon that serves it

```review-callout
warning
Superseded in part, 2026-11-04. A later operator correction kept the daemon
out of tento for this batch: `autophys serve` is the `autophys` binary in
`rwc-dev-01:~/workspace/experiments/autophys`, which also owns the
composition (its client imports `tento-cookbook-js` from this checkout and
fills the slots with placeholder data). `tento/tento-autophys` is **not**
created in this batch, and the app autophys serves is, for now, the vanilla
cookbook skeleton. The shell's own plan and decisions moved to
`projects/tento-cookbook.project.docs` (CB-0..CB-5); the sections below that
describe a tento daemon crate, its deploy script and AP-3/AP-4 now apply to
experiments/autophys and are tracked in its project record. AP-1 (revised) is
the operator's ruling. `architecture.md` in this directory is the
tento-autophys-js agent's page and is unchanged by this note.
```

Status: plan rev 1 in tento (2026-11-04). Precursor: the standalone repository
`rwc-dev-01:~/workspace/experiments/autophys` (commits `f97a2a0`..`c750859`),
where batch 1 was built, deployed and verified before this move.

The operator decided on 2026-11-04 (relayed) that autophys moves into tento
packages on rwc-dev-01. The skeleton built in the precursor — header, pitch
deck, sidebar, details, first-visit tutorial, and the FLIP motion that joins
them — is reusable UI scaffolding, so it becomes **`tento-cookbook-js`**, a
shell with no autophys content. The axum server becomes **`tento-autophys`**,
the autophys daemon, whose first and only subcommand is `autophys serve`.
autophys's own view components live in `tento-autophys-js`, which belongs to
another agent; they are wired into the cookbook later by an autophys
`*.root.ts`, the pattern `tento-cef/html/routes/index.root.ts` uses.

This changes nothing in the deployed contract: same systemd user unit
`autophys.service`, same loopback address `127.0.0.1:4794`, same
`/api/healthz` body, same fleet id `autophys`. It does not write to
`tento-autophys-js`, and it adds no physics, no SDK ingestion and no database;
those are named later responsibilities of the daemon, not this change.

## Why a shell package and not an autophys page

The precursor's client was already written as five independent pieces whose
only autophys-specific parts were placeholder copy. The other agent's
`tento-autophys-js` draws the real sidebar, main and details from a view model
into a host element it is given, and reports intents. Those two halves meet
at mount points: the shell owns layout, motion, routing, header and deck; the
product owns what is drawn inside the panels. Keeping the shell content-free
means the next tento app gets the same flow by passing its own slides,
tutorial steps and mount callbacks.

```review-flow
flowchart LR
  R[autophys index.root.ts\nowner: tento-autophys-js agent] -->|mountCookbook options| C[tento-cookbook-js\nshell, deck, tutorial, panels, FLIP]
  R -->|mounts into slots| V[tento-autophys-js\nsidebar, main, details views]
  D[demo/routes/index.root.ts\nneutral placeholders] -->|until R exists| C
  C -->|bundle: index.root.js + index.html| W[release web/]
  S[tento-autophys\nautophys serve 127.0.0.1:4794] -->|static + /api/healthz| W
  U[autophys.service] --> S
  class C,D,S new
  class U changed
```

## The slot contract

The cookbook exposes three mount points — `queue` (sidebar body), `main`,
`details` — each a callback `(host, shell) => cleanup?`, plus `onSelect(id)`
and `onStage(stage)`. The `shell` handle offers `select(id)`, `setCrumb`,
`setStatus`, `open`, `close`, `reflow` (FLIP a layout change) and the class
names of its toolbar and button recipes, which the autophys components accept
as their `classes` argument. The full API is in
`tento-cookbook-js/README.md`. The other agent will state the slots it needs
in `tento-autophys-js/COOKBOOK-CONTRACT.md`; where the two differ, the reply
is appended to that file, uncommitted, because the file is theirs.

## Phases

```review-table
| Step | Content | State |
| ---- | ------- | ----- |
| 1 | this plan | this commit |
| 2 | `tento-cookbook-js`: the five pieces as a slot-based shell, demo root, bundler, tests, flow check | implementation |
| 3 | `tento-autophys`: `autophys serve`, deploy script and unit template; unit repointed at the new binary | implementation |
| 4 | verification against the redeployed daemon | record |
| later | autophys root.ts wiring `tento-autophys-js` into the cookbook | other agent; not this project |
| later | daemon ingests SDK events and owns a database | pending operator direction |
```

## Decisions

```review-table
| Id   | Decision | Who | Reason / alternative | Reversal cost |
| ---- | -------- | --- | -------------------- | ------------- |
| AP-1 (revised) | autophys lives in tento packages: `tento-cookbook-js` (shell) and `tento-autophys` (daemon, axum), not a standalone repo | **operator, 2026-11-04** | supersedes the precursor's agent-chosen "standalone repo, crates.io axum, no tento" | n/a — operator ruling |
| AP-3 | port `127.0.0.1:4794` kept | agent-chosen, pending operator review | unchanged so the fleet entry and unit stay valid | edit deploy default and self.toml |
| AP-4 | `Restart=on-failure` kept | agent-chosen, pending operator review | crash restarts, deliberate stop stays stopped; alternative `always` | one line in the unit template |
| AP-5 | the shell is plain TypeScript with its own stylesheet, not tento-ui components | agent-chosen, pending operator review | the pieces need ~1,200 lines; tento-ui would add a large closure; alternative: build on tento-ui's shell-layout and Round, sharing fixes with other apps | moderate, piece by piece |
| AP-6 | demo content is neutral placeholders; the demo root takes its wordmark from the page title, which the build sets per app | agent-chosen, pending operator review | the cookbook carries no product copy, yet the autophys service still reads "autophys" until its own root exists | edit `demo/` and build flag |
| AP-7 | every shell class is `ck-` prefixed and the stylesheet ships as a TS string injected once by `mountCookbook` | agent-chosen, pending operator review | product components (`ap-` prefixed) can sit inside the slots without collisions and a root needs no CSS asset; alternative: shadow-DOM isolation, which would hide slot content from the tutorial's target search | rename pass |
```

## Validation

`cargo test -p tento-autophys`; `deno test` of the cookbook's pure logic;
the bundle builds; after redeploy, `curl /api/healthz` through the unit,
`systemctl --user is-active autophys`, a SIGKILL of the server PID with
systemd restarting it, and a headless run through header, deck, tutorial,
sidebar, details, return home and a phone viewport with zero console, page or
network errors. Results go in `verification.md` with screenshots kept under
the ignored `~/workspace/fleet/evidence/autophys/`.

## Scope boundary

This project writes `tento-cookbook-js/`, `tento-autophys/`,
`projects/autophys.project.docs/`, one member line in `Cargo.toml`, the
`tento-autophys` package entry in `Cargo.lock` and two import-map lines in
`deno.json`. It never writes `tento-autophys-js/` except an appended,
uncommitted reply section in its `COOKBOOK-CONTRACT.md` if that file asks for
something this API does not provide. Other sessions' changes in this checkout
(tento-chrono, tento-fleet, tento-lona-js, tento-ui-js, tento-kol) are not
touched, staged or formatted.
