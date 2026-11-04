# autophys is one product repo; tento keeps only the shell any app can reuse

Status: proposal, rev 2, 2026-11-04. Rev 2 applies the operator's answer to
S-2, "src should use tento-web meaning we're using the file based router".
It is awaiting S-1, S-3 and confirmation of how S-2 was read. Nothing has moved yet. It supersedes the tento-package layout
in `architecture.md` and the cover, but only where it says so.

The operator, answering AX-7 during /open-questions on 2026-11-04:

> do we need the separate tento-autophys? can we absorb it into
> workspace/autophys? then we can have workspace/autophys/{cargo.toml, src,
> sdks} etc. spec this out

So the question is whether autophys's daemon, SDK and views belong in tento,
the fleet's shared library repo, or in a repo of their own. This page argues
for their own repo, and keeps in tento the one piece another app would
reuse: the cookbook shell. The physics, the API, the data model and the
architecture are unchanged. Only directories, repos and build glue move.

## What is where today, on rwc-dev-01

```review-table
| Piece                         | Where now                                      | State                                       |
| ----------------------------- | ---------------------------------------------- | ------------------------------------------- |
| batch-1 server + shell        | `~/workspace/experiments/autophys` (own git, no remote) | 5 commits f97a2a0..c750859; lib mid-move, working tree dirty |
| `tento-cookbook-js`           | `tento/tento-cookbook-js`                      | lib, committed 561cad2f5, `Cookbook.mount(…).run(app)` + `Cookbook.View.mount` (N-1) |
| `tento-autophys` (daemon)     | planned in tento                               | not created; held                           |
| `tento-autophys-js` ui + logic | `tento/tento-autophys-js`                     | committed: 2ce38f4a1, 5eade0b4b, 2254362cb, af2eedbdc (37 tests); runs in the cookbook |
| store (DB, `/api/v1`, SSE)    | `tento/tento-autophys-store`                   | agent building; commits held                |
| Python SDK                    | `tento/tento-autophys-py` (copy of yuzuquats hacks-site) | agent building; commits held     |
| records                       | `tento/projects/autophys.project.docs` (cover, architecture) and `experiments/autophys/autophys.project.docs` (B1) | two homes |
```

Two things in that table are the real problem. First, the records already
have two homes. Second, the contract between daemon, SDK and client is split
across three tento packages, so one API change (E-1's `outlook` field, for
instance) is three commits in two languages, landing on a shared master that
other sessions also write. The fleet rule is that a type change publishes as
one commit with its consumers. Today that commit would have to straddle
packages owned by different agents.

## The shape

The daemon is a tento-web app, built the way every tento-web node is built
(paper-reader, media, tento-cef). `src/app.rs` returns a `DomainConfig` whose
compiler bundles `html/routes/*.root.ts` and `*.anon.html` by file name. API
handlers are registered on the same actix app. So the browser code lives in
`html/` beside the routes that load it. In dev, `autophys serve` bundles on
start and rebuilds when anything the build read changes, cookbook edits
included. In deploy, `autophys build-web` writes a prebuilt tree that
`autophys serve --web-root` serves.

```
~/workspace/autophys/                    one git repo, history from experiments/autophys
├── Cargo.toml  Cargo.lock               package `autophys`, bin `autophys`; tento-web by path
├── src/
│   ├── main.rs                          serve | build-web | pair | keys | db
│   ├── app.rs                           DomainConfig: compiler deps + cfg.route("/api/v1/…")
│   ├── server.rs                        loopback refusal, Webapp::build_beta or prebuilt root
│   ├── http.rs                          actix handlers + SSE for /api/v1 (configure(cfg, state))
│   ├── store/                           SQLite log, projections, migrations, keys — no web types
│   └── ingest.rs                        validate → append → project → broadcast
├── html/                                the file-based router's root
│   ├── tsconfig.json                    paths: @tento-ui/*, @tento-cookbook/* → ../vendor/tento/…
│   ├── routes/
│   │   ├── index.anon.html              the page shell (loads /index.root.js)
│   │   └── index.root.ts                Cookbook.mount(…) + the three views
│   ├── ui/                              view-only components (was tento-autophys-js/ui)
│   └── client/                          store · derive · controller · fixtures
├── sdks/python/                         pyproject.toml, src/autophys/, tests/
├── tests/                               actix contract tests for /api/v1
├── e2e/                                 real daemon + SDK benchmark + headless Approve
├── ops/                                 deploy.sh, systemd/autophys.service.in (current template path)
└── autophys.project.docs/content/       the one record
```

```review-flow
flowchart LR
  subgraph tento
    cookbook[tento-cookbook-js]:::changed
    tentoui[tento-ui-js]
  end
  web[autophys/html]:::new -->|tsconfig paths| cookbook
  web --> tentoui
  daemon[autophys/src]:::new -->|tento-web compiles + serves routes| web
  tweb[tento-web crate]
  daemon -->|path dependency| tweb
  sdk[autophys/sdks/python]:::new -->|/api/v1| daemon
  web -->|/api/v1 + SSE| daemon
  old1[tento-autophys]:::removed
  old2[tento-autophys-js]:::removed
  old3[tento-autophys-store]:::removed
  old4[tento-autophys-py]:::removed
```

```review-compare
== before: five homes for one product
tento/tento-autophys          daemon (planned)
tento/tento-autophys-store    DB + API
tento/tento-autophys-js       ui + client + root
tento/tento-autophys-py       SDK
experiments/autophys          B1 server + shell, its own record
== after: one repo, one shared dependency
autophys/{src, html, sdks/python, tests, e2e, ops, autophys.project.docs}
tento/tento-cookbook-js       the shell, reusable by any app
```

### What crosses the repo boundary

Two things cross it, both pointing into the sibling tento checkout: the Rust
crate depends on `tento-web` (and `tento-dirs`) by path, and `html/` imports
the cookbook and tento-ui through tsconfig paths. Python imports nothing from
tento.

```toml
# autophys/Cargo.toml
[package]
name = "autophys"
version = "0.1.0"
edition = "2024"
publish = false

[[bin]]
name = "autophys"
path = "src/main.rs"

[dependencies]
tento-web  = { path = "vendor/tento/tento-web" }
tento-dirs = { path = "vendor/tento/tento-dirs" }
actix-web = "4"                      # the version tento's workspace pins
rusqlite = { version = "0.32", features = ["bundled"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
sha2 = "0.10"
tokio = { version = "1", features = ["rt-multi-thread", "macros", "sync"] }

# tento's root [patch] block applies only inside tento's workspace
[patch.crates-io]
fsevent-sys    = { path = "vendor/tento/vendor/fsevent-sys" }
notify         = { path = "vendor/tento/vendor/notify" }
iana-time-zone = { path = "vendor/tento/vendor/iana-time-zone" }
```

Measured on rwc-dev-01 (2026-11-04): a crate outside tento with exactly that
path dependency resolves, with or without the patch block. That's 502
packages, 39 of them tento path crates. Nothing was compiled, so build time
and whether it compiles cleanly against an independent lockfile are still
open. Seeding `Cargo.lock` from tento's keeps versions matched.

```rust
// autophys/src/app.rs — the tento-web wiring, after paper-reader.node
pub fn domain(config: &AppConfig, state: web::Data<ApiState>) -> DomainConfig {
    let compiler = Compiler::builder()
        .dep(("html", Action::RebuildRoutes))
        .dep(("../vendor/tento/tento-cookbook-js", Action::RebuildRoutes))
        .dep(("../vendor/tento/tento-ui-js", Action::RebuildRoutes))
        .build();
    DomainConfig::builder()
        .hostname("localhost")
        .project_root(config.project_root.clone())
        .compiler(Some(compiler))
        .config(move |cfg| {
            cfg.app_data(state.clone());
            cfg.route("/api/healthz", web::get().to(healthz));
            http::configure(cfg);            // every /api/v1 route + SSE
        })
        .build()
}
```

```jsonc
// autophys/html/tsconfig.json
{
  "compilerOptions": {
    "paths": {
      "@tento-ui/*":       ["../vendor/tento/tento-ui-js/*"],
      "@tento-core/*":     ["../vendor/tento/tento-core-js/*"],
      "@tento-cookbook/*": ["../vendor/tento/tento-cookbook-js/*"]
    }
  },
  "extends": "../vendor/tento/tento-web-js/tsconfig.base.json",
  "include": ["**/*.ts", "../vendor/tento/tento-ui-js/types/*.d.ts"]
}
```

```ts
// autophys/html/routes/index.root.ts
import "@tento-ui/init";
import { Cookbook } from "@tento-cookbook/lib.ts";
import { AutophysDetails, AutophysMain, AutophysSidebar } from "../ui/lib.ts";
import { daemon } from "../client/api.ts";
// … Cookbook.mount / Cookbook.View.mount as in architecture.md (N-1)
```

```review-callout
kind: decision
title: AP-1 reversed by the operator — tento-web, not crates.io axum
Operator, 2026-11-04 (S-2 answer). The batch-1 server's axum router and the
store agent's axum draft become actix handlers registered through
`DomainConfig::config`. The store core (log, projections, keys) stays free of
web types, so the switch only touches `http.rs`.
```

### One command per job

```
cargo test                                   # daemon + actix contract tests
deno test --allow-read html/                 # ui + client boundary/render/flow tests
python -m pytest sdks/python                 # SDK, against the fake server
e2e/run                                      # real daemon + SDK benchmark + headless approve
autophys serve                               # dev: bundles html/routes, rebuilds on change
autophys build-web                           # deploy: prebuilt route tree
ops/deploy.sh                                # build-web + bin, install, restart unit (serve --web-root)
```

The e2e script is the payoff of one repo. A single commit can change the
`outlook` field in `src/store`, `sdks/python` and `html/client`, and one script
proves all three agree.

## How it moves (once S-1..S-3 are answered)

```review-steps
1. Move `experiments/autophys` to `~/workspace/autophys` as a directory (same .git, history and Change-Ids intact); lib's uncommitted B1-to-tento edits are reconciled first, by lib.
2. Restructure commit in the autophys repo: `server/src` → `src/` on tento-web (actix), `web/src` shell code → deleted (the cookbook provides it), record kept.
3. Import commits: `tento-autophys-js/ui` → `html/ui`, its logic → `html/client`, its root → `html/routes`, `tento-autophys-store` → `src/{store,http,ingest}`, `tento-autophys-py` → `sdks/python`; each commit names its source commit or path and keeps its Change-Id.
4. Records: `tento/projects/autophys.project.docs/content/{README,architecture,repo}.md` move into `autophys/autophys.project.docs/content/`; tento keeps a `tento-cookbook` project for the shell.
5. Removal commit in tento (operator OK required): drop `tento-autophys-js/` (2ce38f4a1, 5eade0b4b) and the moved project pages; nothing else in tento changes.
6. Workspace registration per S-1; `autophys.service` and the fleet entry keep their id and port (AP-3).
```

```review-callout
kind: decision
title: AX-8 — the cookbook stays in tento
Agent-chosen, pending operator review. The cookbook is the only piece whose
next user is not autophys. The operator named it as the reusable scaffolding,
and hacks-site and future miniapps are its audience. Moving it into the
autophys repo would make every other app depend on a physics product.
```

## Questions this needs answered

```review-steps
1. S-1: how the workspace holds the repo — a submodule with a new private GitHub remote (like lona, tsh, tento), or tracked directly in the workspace repo (like commit-review, model-usage).
2. S-2 (answered, reading to confirm): the daemon uses tento-web's file-based router, so the routes live in `autophys/html/routes`; read as the ui and client moving into `autophys/html/` too.
3. S-3: whether tento's committed `tento-autophys-js` (2ce38f4a1, 5eade0b4b) may be removed from tento master once it is imported.
```

```review-table
| S-1 option            | Benefit                                                 | Cost |
| --------------------- | ------------------------------------------------------- | ---- |
| submodule + remote    | own history, own CI, same shape as every product repo   | creates a GitHub repo (outward-facing; needs OK); every host clones it |
| tracked in workspace  | no external step; precedent: commit-review, model-usage | product commits land in the fleet-shell repo; history imported by subtree merge |
| stay in experiments/  | nothing to register; it's where unpublished apps go     | not `workspace/autophys`, which is what the operator asked for |
```

```review-callout
kind: risk
title: What this does not settle
The path dependencies into `vendor/tento` assume every host that builds
autophys has `vendor/tento` present. A build of `html/` without it fails at
build time, not at runtime, which is the safe failure. Also unmeasured: lib's
in-flight move of B1 into tento. Its uncommitted edits in
`experiments/autophys` have to be reconciled by lib before step 1, or they are
lost in the restructure. Also not yet tried: whether tento-web's bundler
accepts a project root outside tento, given its tsconfig `extends` checks. The
first build in step 2 settles it.
```
