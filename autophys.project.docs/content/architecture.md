# The daemon's record log is the only state; the shell, the views and the SDK are all readers or writers of it

Status: architecture page, rev 1, 2026-11-04. This page extends the project
cover (`README.md`, Change-Id I6a0c3e5b19d84f27a1c5, hackathon/lib). The cover
owns `tento-cookbook-js` and the `autophys serve` skeleton. This page covers
what the cover leaves open: the composition root, the client layer, the
daemon's events and database, and the SDK path. Nothing here is built yet. Two
things exist today and are both inputs. One is the batch-1 skeleton in
`rwc-dev-01:~/workspace/experiments/autophys` (commits f97a2a0..c750859), a
fixed shell plus a healthz server. The other is the view-only components
taking shape in `tento-autophys-js` (UI agent, in progress). The Python SDK
exists on yuzuquats, `hacks-site/exp/modellab/python` (55 tests pass), and
speaks a draft REST contract that no server implements yet.

The operator asked on 2026-11-04 for this split:

> separate out a tento-autophys-js/ui and tento-autophys. tento-autophys is the
> rust server/daemon that consumes and processes the events and manages the
> database. `autophys serve` should serve the server. this means the core ui
> scaffolding should be pulled into tento-cookbook-js … some *.root.ts code
> takes tento-autophys-js/ui and wires it up with the cookbook so we can render
> the app.

The split changes where code lives and which way imports point. It does not
change the physics, the SDK's numerics or the shell's look. It does not touch
hacks-site. The cover's AP-1 to AP-7 decisions stand; this page adds AX-1 to
AX-6.

## What exists, and why it cannot simply be split by moving files

The batch-1 shell is a page, not a library. `web/src/panels.ts` writes its own
sidebar list, main title and details facts from a placeholder `items` array.
Its FLIP motion animates a fixed list of the shell's own elements:

```
// experiments/autophys/web/src/panels.ts
const motion = new Motion(() => [
  [title, "move"], [q(".stage-backdrop"), "box"], [q(".stage-label"), "move"],
  [toggles.sidebar, "move"], [toggles.details, "move"],
]);
```

So "pull the scaffolding into a cookbook" means one specific change. The
shell has to stop owning what is inside its three panels and start offering
them as **slots**. It also needs a way for slot content to join a FLIP pass
it does not know about. Without that, the operator's "the ui should flow
seamlessly" holds for the shell's chrome and breaks for every autophys view.

The UI components already have the opposite shape: they own nothing. The
sidebar has no selection or expansion state of its own, and a boundary test
forbids network, storage and timer calls in the components:

```
// tento-autophys-js/sidebar.ts
export class AutophysSidebar {
  constructor(host: HTMLElement, private onIntent: IntentHandler) { … }
  render(model: SidebarModel): void { … }      // draws, never decides
}
```

So the two halves meet in the middle: a shell with empty slots, and views
that fill a host element from a model. Something has to own the model,
which is the composition root plus a client layer. That layer is the one
piece nobody has written yet.

## The shape

```
                 ┌──────────────────────── browser ────────────────────────┐
                 │                                                         │
                 │  tento-autophys-js/app/routes/index.root.ts (the root)  │
                 │      │ boots            │ fills slots    │ owns state   │
                 │      ▼                  ▼                ▼              │
                 │  tento-cookbook-js   tento-autophys-js  tento-autophys-js│
                 │  shell · deck ·      /ui                /client         │
                 │  tutorial · FLIP     view-only          store · derive ·│
                 │  (knows no physics)  (knows no data)    controller · api│
                 │                                          │   ▲          │
                 └──────────────────────────────────────────┼───┼──────────┘
                                                  fetch/POST│   │SSE /api/v1/stream
                 ┌──────────────────────────────────────────▼───┴──────────┐
                 │  tento-autophys  (Rust, `autophys serve`, 127.0.0.1:4794)│
                 │  http ─▶ ingest ─▶ store (SQLite: records + projections) │
                 │   │                    │                                 │
                 │   └ serves webapp/  ◀── build-web (tento-web esbuild)    │
                 └──────────────────────────────────────────▲──────────────┘
                                                            │ POST records
                 ┌──────────────────────────────────────────┴──────────────┐
                 │  Python SDK on the user's laptop: fits, sensitivity,    │
                 │  experiment design, agent loop → uploads every step     │
                 └─────────────────────────────────────────────────────────┘
```

```review-flow
flowchart LR
  root[index.root.ts]:::new --> cookbook[tento-cookbook-js]:::new
  root --> ui[tento-autophys-js/ui]:::changed
  root --> client[tento-autophys-js/client]:::new
  client --> ui
  client -->|HTTP + SSE| daemon[tento-autophys]:::new
  sdk[Python SDK]:::changed -->|records| daemon
  daemon -->|serves bundle| root
```

### Import rules

The arrows go one way only, and each package has its own boundary test,
like the one `tento-autophys-js` already has.

```review-table
| Package                       | May import                                 | Must not import                     |
| ----------------------------- | ------------------------------------------ | ----------------------------------- |
| `tento-cookbook-js`           | tento-ui, its own files                    | anything autophys                   |
| `tento-autophys-js/ui`        | tento-ui tree list, its own files          | cookbook, client, fetch, storage    |
| `tento-autophys-js/client`    | `ui` **types only**, its own files         | cookbook, DOM components            |
| `tento-autophys-js/app`       | all three                                  | — (it is the only place they meet)  |
```

The client imports only `ui`'s view-model *types*. Its derive step outputs
`SidebarModel`, `MainModel` and `DetailsModel` exactly, so the compiler checks
the seam between data and drawing. The cookbook never learns that physics
exists.

## Package by package

### tento-cookbook-js: the shell with slots (owner: hackathon/lib)

The API belongs to the cover and to `tento-cookbook-js/README.md` once that
is written. What follows is the cover's stated contract, quoted here so the
root example below can be checked against it:

```ts
// tento-cookbook-js — as stated in the cover (signatures are lib's to finalize)
type Mount = (host: HTMLElement, shell: Shell) => (() => void) | void;   // returns cleanup

mountCookbook({
  title, slides, tutorial,            // product copy; the cookbook ships none
  queue: Mount, main: Mount, details: Mount,
  onSelect(id: string): void,         // the address changed to /app/<id>
  onStage(stage: "landing" | "tour" | "app"): void,
});

interface Shell {
  select(id: string): void;           // navigate; Back/Forward replay onSelect
  setCrumb(parts: Crumb[]): void;
  setStatus(line: { text: string; tone: string }): void;
  open(which: "sidebar" | "details"): void;
  close(which: "sidebar" | "details"): void;
  reflow(change: () => void): void;   // FLIP a layout change, slot content included
  classes: { toolbar: string; button: …};  // recipes the autophys views accept
}
```

Two requirements from this side, both in `COOKBOOK-CONTRACT.md`:

```review-steps
1. `reflow` must FLIP elements inside slots it did not create (a `[data-flip]` opt-in is enough); otherwise every view update jumps.
2. Tutorial targets must be resolvable inside slots, so a tour step can point at the investigation tree or the Approve button.
```

```review-callout
kind: decision
title: AX-1 — the shell hands out slots; it never asks for components
Agent-chosen, pending operator review. The cover takes the same position.
The strongest alternative is a `mountCookbook` that receives
`{sidebar: Component, …}` and constructs and renders them itself. That shape
would let the shell own the render loop and FLIP every update itself. It was
rejected because it forces the view components into a shell-defined
lifecycle, and `tento-autophys-js/ui` would then import the cookbook. With
slots, the ui stays testable alone, and a second app can reuse the cookbook
without adopting its component model. Reversing it costs one adapter in the
root.
```

### tento-autophys-js/ui: view-only (owner: UI agent, in progress)

It is unchanged from the current design, apart from moving under `ui/`. It
renders a derived model and reports raw intents:

```ts
export type Intent =
  | { kind: "select"; id: string }
  | { kind: "toggle"; id: string; open: boolean }
  | { kind: "switch"; value: string }
  | { kind: "action"; name: string }                       // "approve", "reject", …
  | { kind: "field"; name: string; raw: string; commit: boolean };
```

The surfaces are `AutophysSidebar`, `AutophysMain` and `AutophysDetails`,
each a `new X(host, onIntent)` followed by `render(model)`. The charts are SVG
built from data coordinates: xy, heatmap, bars and ranges.

### tento-autophys-js/client: the logic the ui refuses to hold (new)

```
tento-autophys-js/client/
  api.ts          fetch + EventSource against /api/v1; the only network code
  store.ts        records by investigation, applied in seq order; snapshot()
  derive/         snapshot + selection → {sidebar, main, details} view models
    tree.ts         investigation tree, trails, badges, view-hint leaves
    fit.ts          fit / residuals / landscape panels from run payloads
    proposal.ts     ranking bars, expected-uncertainty table, Approve/Reject
  controller.ts   Intent → selection change, navigate(), or an API call
  fixtures/       a Source that replays canned records (dev and tests)
tento-autophys-js/app/
  routes/index.anon.html, index.root.ts, content.ts   the composition root (below)
```

The store reads from one interface, so fixtures and the daemon are
interchangeable:

```ts
// client/api.ts
export interface Source {
  load(): Promise<Snapshot>;                        // GET /api/v1/workspace
  stream(after: number, on: (r: Rec) => void): () => void;   // SSE, resumable
  post(path: string, body: unknown): Promise<Rec>;  // approvals, edits
}
export const daemon = (base = "/api/v1"): Source => ({ … });
export const fixtures = (records: Rec[]): Source => ({ … });   // client/fixtures
```

Derive does no numerics. It formats what the SDK already computed: fits,
singular values, Fisher scores and landscapes arrive in `run` and `step`
payloads. It also picks which leaves exist from the config's view hints
(`envelope`, `frequency`, `zoom:edges`).

```review-callout
kind: decision
title: AX-2 — numerics live in the SDK only
Agent-chosen, pending operator review. The daemon validates and stores; the
client formats. The alternative is to recompute landscapes in the browser for
interactivity, as the earlier mock did with RK4 in JS. That would mean a second
simulator implementation that can disagree with the one that produced the
fit. The cost is that a landscape is only as fine as the grid the SDK
uploaded.
```

### The composition root (`tento-autophys-js/app`)

The root lives with the views, as the cover's diagram has it, so the daemon
crate stays free of product UI. It follows tento's convention for a routes
directory: tento-cef keeps `html/routes/index.anon.html` and `index.root.ts`,
which `src/bin/build_web.rs` bundles through `tento-web` (esbuild under Deno).
The daemon's deploy step builds `tento-autophys-js/app` the same way and
serves the output.

```ts
// tento-autophys-js/app/routes/index.root.ts
import { mountCookbook, type Shell } from "@tento-cookbook/mod.ts";
import { AutophysDetails, AutophysMain, AutophysSidebar } from "@tento-autophys/ui/lib.ts";
import { daemon } from "@tento-autophys/client/api.ts";
import { Store } from "@tento-autophys/client/store.ts";
import { Controller } from "@tento-autophys/client/controller.ts";
import { derive, type View } from "@tento-autophys/client/derive/index.ts";
import { slides, tutorial } from "./content.ts";

const store = new Store(daemon());              // the only state in the page
const ctl = new Controller(store);              // selection + intent handling
let view: View = derive(store.snapshot(), ctl.selection);
const draws = new Set<() => void>();

mountCookbook({
  title: "autophys",
  slides,
  tutorial,
  queue: (host, shell) => mountView(new AutophysSidebar(host, ctl.handle), (v) => v.sidebar, shell),
  main: (host, shell) => mountView(new AutophysMain(host, ctl.handle, shell.classes), (v) => v.main, shell),
  details: (host, shell) => mountView(new AutophysDetails(host, ctl.handle, shell.classes), (v) => v.details, shell),
  onSelect: (id) => ctl.select(id),             // /app/<id>, incl. Back/Forward
  onStage: (stage) => stage === "app" && void store.start(),
});

function mountView<M>(surface: { render(m: M): void; destroy(): void }, pick: (v: View) => M, shell: Shell) {
  const draw = () => shell.reflow(() => surface.render(pick(view)));
  draws.add(draw);
  draw();
  ctl.navigate = (id) => shell.select(id);      // controller asks; the shell owns the URL
  return () => { draws.delete(draw); surface.destroy(); };
}

const redraw = () => { view = derive(store.snapshot(), ctl.selection); draws.forEach((d) => d()); };
store.subscribe(redraw);
ctl.subscribe(redraw);
```

That is the whole join. Every decision in it belongs to the controller or to
derive.

### tento-autophys: the daemon (Rust)

```
tento-autophys/
  Cargo.toml              [[bin]] autophys   (+ build-web behind feature "web")
  src/main.rs             clap: serve | pair | keys | db
  src/http/               router, bearer-key extractor, /api/v1 routes, SSE
  src/ingest.rs           validate → append → project → broadcast
  src/store/              rusqlite: migrations, records, projections, keys
  ops/                    deploy (builds tento-autophys-js/app → web/), unit template
  tests/                  HTTP contract tests (the SDK's fake_server, made real)
```

The cover's step 3 creates it from the batch-1 `autophys-server`
(`parse_loopback`, `app`, `serve`, `termination`), keeping the loopback
refusal and `serve` as its only subcommand. Everything below is the next
layer on top, and the cover marks it "pending operator direction".

```
$ autophys serve                      # 127.0.0.1:4794, ~/.local/share/autophys/autophys.db
$ autophys serve --addr 127.0.0.1:4795 --db /tmp/a.db --web ./webapp
$ autophys pair approve WXYZ-1234     # approve an SDK's device code from the server host
$ autophys keys list                  # id, device, created, last used — never the key
$ autophys keys revoke k_7f3a
$ autophys db check                   # verify every hash chain, rebuild projections
```

**One event path.** Every write, whether from the SDK or the UI, is a record
appended through the same function:

```rust
// src/ingest.rs
pub fn append(&self, inv: &InvestigationId, env: Envelope) -> Result<Record, IngestError> {
    let tx = self.db.transaction()?;
    if let Some(existing) = records::by_id(&tx, &env.id)? {
        return Ok(existing);                          // idempotent replay of a client id
    }
    validate::payload(env.kind, &env.payload)?;       // 422 with the field path
    projections::check(&tx, inv, &env)?;              // 409: approving a non-proposed proposal
    let head = records::head(&tx, inv)?;              // (seq, hash) or (0, GENESIS)
    let hash = chain_hash(&head.hash, &env);          // sha256(prev ‖ canonical{id,kind,payload})
    let rec = records::insert(&tx, inv, head.seq + 1, &env, &head.hash, &hash)?;
    projections::apply(&tx, &rec)?;                   // investigations.status, proposals.state …
    tx.commit()?;
    let _ = self.bus.send(rec.clone());               // SSE subscribers; lagging ones resync
    Ok(rec)
}
```

SQLite is synchronous, so a single writer thread owns the connection. HTTP
handlers send it work over a channel. Reads use a small pool of read-only
connections in WAL mode.

```sql
-- the log: the only table that is ever the source of truth
CREATE TABLE records (
  gseq        INTEGER PRIMARY KEY,            -- global order; the SSE cursor
  id          TEXT NOT NULL UNIQUE,           -- client-chosen, = Idempotency-Key
  investigation TEXT NOT NULL,
  seq         INTEGER NOT NULL,               -- per-investigation order
  kind        TEXT NOT NULL,                  -- investigation|measurement|run|step|proposal|outcome
  ts          TEXT NOT NULL,
  payload     TEXT NOT NULL,                  -- canonical JSON
  prev_hash   TEXT NOT NULL,
  hash        TEXT NOT NULL,
  UNIQUE (investigation, seq)
);
-- projections: rebuildable from records by `autophys db check --rebuild`
CREATE TABLE investigations (id TEXT PRIMARY KEY, project TEXT, config_version TEXT,
                             status TEXT, budget_used INTEGER, updated TEXT);
CREATE TABLE proposals      (id TEXT PRIMARY KEY, investigation TEXT, state TEXT,
                             experiment TEXT, settings TEXT);
-- reference data, written directly
CREATE TABLE projects        (id TEXT PRIMARY KEY, name TEXT UNIQUE);
CREATE TABLE config_versions (project TEXT, version TEXT, body TEXT, PRIMARY KEY (project, version));
CREATE TABLE keys            (id TEXT PRIMARY KEY, device TEXT, sha256 TEXT UNIQUE,
                              created TEXT, last_used TEXT, revoked TEXT);
CREATE TABLE pairings        (device_code_sha256 TEXT PRIMARY KEY, user_code TEXT,
                              expires TEXT, key_id TEXT);
```

```review-callout
kind: decision
title: AX-3 — one SQLite file, an append-only log, projections derived from it
Agent-chosen, pending operator review. The SDK already chains record hashes,
so the log is the record of what the agent did, and the operator can audit it
with `db check`. The strongest alternative is plain tables updated in place,
which is simpler to query. It loses the audit trail and makes the SDK's
idempotent retry rules harder to honour. Postgres was not considered for a
loopback single-user daemon. Reversing later means a migration that replays
the log into the new tables, which is cheap while the log is the source.
```

### API: the SDK's draft contract, rehomed

The routes are the SDK's draft `/api/modellab` table, moved to `/api/v1` on
autophys's own port. Two additions serve the browser.

```review-table
| Route                                              | Caller  | Note                                        |
| -------------------------------------------------- | ------- | ------------------------------------------- |
| `POST /pair/start`, `/pair/poll`                    | SDK     | device code; approved by CLI or the UI      |
| `GET /whoami`                                       | SDK     |                                             |
| `GET/POST /projects`, `PUT …/config_versions/{sha}` | SDK     | 422 `hash_mismatch` if body ≠ sha           |
| `POST /investigations`                              | SDK     | 409 `unknown_config_version`                |
| `POST /investigations/{id}/{measurements,runs,steps,outcome,proposals}` | SDK | all go through `append` |
| `POST …/proposals/{pid}/approvals`                  | **UI**  | approved / edited / rejected; 409 unless proposed |
| `POST …/proposals/{pid}/data`                       | SDK     | 409 unless approved or edited               |
| `GET /workspace` *(new)*                            | UI      | projects + projections + records, one load  |
| `GET /stream?after={gseq}` *(new)*                  | UI, SDK | SSE of records; resumes from a cursor       |
```

The browser is served from the same origin on loopback, so it needs no
API key. Every non-loopback caller does.

### The approval round trip, end to end

```review-seq
sequenceDiagram
  participant SDK as Python SDK
  participant D as autophys daemon
  participant UI as browser (root + client)
  SDK->>D: POST /investigations/i1/proposals {event: proposed, sine 0.44 Hz}
  D-->>UI: SSE record gseq 812
  UI->>UI: store.apply → derive → shell.reflow(render); badge "1" on i1
  UI->>D: POST …/proposals/p3/approvals {event: approved}
  D-->>SDK: SSE record gseq 813 (or GET proposal on its next poll)
  SDK->>SDK: run the experiment in the lab / simulator
  SDK->>D: POST …/proposals/p3/data {measurement_version}
  D-->>UI: SSE gseq 814..820 (measurement, run, step, outcome)
```

```review-state
stateDiagram-v2
  [*] --> proposed
  proposed --> approved: UI approve
  proposed --> edited: UI edit settings
  proposed --> rejected: UI reject
  proposed --> withdrawn: SDK withdraw
  approved --> data_attached: SDK data
  edited --> data_attached: SDK data
  data_attached --> [*]
  rejected --> [*]
  withdrawn --> [*]
```

## Recommendations

```review-table
| Question                                   | Answer                                         | Why |
| ------------------------------------------ | ---------------------------------------------- | --- |
| Where does `*.root.ts` live?               | `tento-autophys-js/app/routes/`                 | matches the cover; the daemon crate stays free of product UI |
| Does `ui` know the cookbook?               | No (AX-1)                                       | ui stays testable alone; cookbook stays generic |
| Who computes charts?                       | SDK computes, client formats (AX-2)             | one simulator, no disagreement |
| Storage?                                   | SQLite log + projections (AX-3)                 | audit trail, idempotent retries |
| Live updates?                              | SSE with a `gseq` cursor (AX-4)                 | one-way fits; reconnect resumes; no WS dep |
| Bind?                                      | loopback only, reach it through tento.localhost (AX-5) | the existing `parse_loopback` stays the rule |
| Name on disk?                              | `autophys` everywhere new (AX-6)                | `~/.config/autophys/credentials`, `AUTOPHYS_API_KEY`; SDK renamed when it moves |
| Big measurement arrays?                    | inline JSON up to 1 MiB for now                 | benchmarks are kilobytes; blobs deferred (D3) |
```

## Phases

The cover's steps 2–4 (cookbook, `autophys serve`, verification) come first
and are not repeated here. This page's phases follow them:

```review-steps
1. ui: `tento-autophys-js/ui` view-only + `COOKBOOK-CONTRACT.md` — UI agent, in progress.
2. root on fixtures: `tento-autophys-js/app` mounts the ui into the cookbook with a fixtures `Source`; the served page shows real autophys views on canned data.
3. store: SQLite log, ingest, projections, `/api/v1` contract tests, pairing and keys subcommands in `tento-autophys`.
4. client: `api.ts` + `store.ts` + `derive/` against the daemon; fixtures stay as a `Source` for tests.
5. round trip: SDK retargeted to `/api/v1` (renamed to autophys), a benchmark run uploads live, and an approval in the UI unblocks the SDK.
6. D1 deferred: non-loopback / cloud serving and multi-user accounts.
7. D2 deferred: SDK resume across processes (today `run()` returns `awaiting_data` and resumes only in-process).
8. D3 deferred: content-addressed blob uploads for measurements over 1 MiB.
9. D4 deferred: retire `experiments/autophys` once the cover's step 3 replaces it — needs the operator's OK.
```

## Scope boundary

- **hacks-site (yuzuquats):** untouched. The UI agent's uncommitted
  `exp/modellab/js` files stay where they are, as does the untracked yuzuquats
  copy of `tento-autophys-js`, until the operator OKs removing them.
- **Python SDK:** stays in `hacks-site/exp/modellab/python` until phase 6. Its
  new home is open question O-1 below.
- **`experiments/autophys`:** stays the running app until phase 3 takes its
  unit over. Its project record keeps batch-1 history.
- **Ownership:** `tento-cookbook-js` and the `serve` skeleton of
  `tento-autophys` are hackathon/lib's. Phase 3 adds to that crate, so its
  owner is open question O-4. Shared tento
  checkouts on rwc-dev-01 carry other sessions' dirty files, so every writer
  stages only its own paths with a private index.

## Open questions

```review-steps
1. O-1: where the SDK lives — `tento/tento-autophys-py/` (recommended: its own package, pip-installable from the repo) or `tento-autophys/python/` beside the daemon.
2. O-2: is "autophys" the user-facing product name everywhere, retiring "ModelLab"? This plan assumes yes (AX-6).
3. O-3: does the UI approve pairings too (a "Pair device" button showing the user code), or only `autophys pair approve` on the host?
4. O-4: who builds phase 3 inside `tento-autophys` — hackathon/lib, which owns the crate, or a new agent working beside it.
```

```review-callout
kind: risk
title: What is not measured, and what would falsify this plan
Nothing here is benchmarked. SSE fan-out and the single SQLite writer are
assumed fast enough because one SDK run writes about a hundred records. That
has not been measured. The cookbook contract has not been tried against the
batch-1 drawer either. If the drawer's FLIP needs to own slot content to
animate it, opaque slots and `shell.reflow` are wrong and AX-1 falls. The
first thing phase 2 should show is a slot whose content moves seamlessly when
a panel toggles. The SDK's HTTP client has only met a fake server, so phase 4's
contract tests are the first real check of the draft API.
```
