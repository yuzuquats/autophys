# autophys starts as a running shell, and grows only by pieces it needs

Status: plan rev 2 (scope corrected by the operator, 2026-11-04). Batch 1,
the skeleton shell, is implemented, deployed on rwc-dev-01 and registered to
the fleet; later batches wait for operator direction.

The operator asked, on 2026-11-04, to "rebuild the app from first
principles", pulling pieces slowly into a new repository called autophys on
rwc-dev-01, built in batches so the skeleton exists and runs first, then
registered to the fleet. They clarified that autophys is **a new physics
app**, and then narrowed batch 1:

> do not do the physics code from light scatter. i want purely a skeleton on
> rwc-dev-01 containing the sidebar, header, details, tutorial and pitch deck.
> the ui should flow seamlessly and nothing else

So batch 1 contains no physics, no canvas solver and nothing from
light-scatter. It is the hacks-site app shell, reduced to five pieces and
rewritten here: the **sidebar**, the **header**, the **details** panel, the
first-visit **tutorial**, and the **pitch deck**, with the motion that joins
them. Every slot that needs content holds a neutral placeholder naming
autophys; none of hacks-site's product claims came across.

This project changes nothing outside its own repository, its own systemd
user unit, its own release directory and one appended entry in rwc-dev-01's
fleet self-declaration. hacks-site (owner yuzuquats) and its read-only mirror
on rwc-dev-01 were only read.

## The rule that makes this a rebuild

The hacks-site client is built on vendored tento-ui and tento-brand
components (Round, std-carousel, item lists, property lists, an app-shell
custom element and a page engine), a workbench registry with fourteen
candidate workbenches, an experiment index and an inference gateway. Copying
the five pieces as they stand would have carried all of that, because each
piece imports it. Starting empty carries none of it:

```review-callout
decision
A piece is pulled only when the current batch needs it. It is read in its
source, rewritten or trimmed to what autophys uses, and committed here with
its origin named (repo, path, commit). Nothing is bulk-copied, and no piece
arrives with a dependency on another fleet tree unless that dependency is
itself the decision being made.
```

## Where each piece came from

Source: the hacks-site mirror at `rwc-dev-01:~/.local/share/tento/hacks-site/mirror`,
a `git archive` of yuzuquats workspace commit `c9239fb4b571`.

```review-table
| autophys file          | hacks-site source                                   | kept                                                                 | left behind |
| ---------------------- | --------------------------------------------------- | -------------------------------------------------------------------- | ----------- |
| `web/src/header.ts`    | `client/chrome.ts` (HacksSiteHeader)                | wordmark, landing link, app-state menubar, back arrow, breadcrumb, FLIP on the wordmark | HacksSiteChrome base class, Round surface, footer, product links |
| `web/src/deck.ts`, `deck-data.ts` | `client/home-deck.ts`, `home-carousel.ts` | one slide frame, six body kinds, card-recede carousel, counter, arrows, swipe | page-model hook, HacksUi, std-carousel, carousel texture, media and custom bodies, product pitches |
| `web/src/drawer.ts`    | `client/app-drawer.ts`                              | surface lowers to a 200px peek, peek carries the tutorial, Up/Down stops, URL as state, interrupt-safe moves | workbench registry, product switching, Round radius morph, legacy URL forms |
| `web/src/panels.ts`, `motion.ts`, `flip.ts` | `client/app-panels.ts`, `client/workbench/motion.ts`, `workbench/styles.ts` | sidebar and details slide from their edges, toggles dock in the panel header, FLIP of main content, phone one-pane sheets | review queue, decisions, candidate workbenches, resize handles, tento-ui controls, export |
| `web/src/tutorial.ts`  | `client/app-tutorial.ts`                            | stepper with progress bars, Show me ring that tracks its target, Next/Done, close | per-product steps, step images |
| `web/src/style.css`    | `client/design-system/tokens.ts`                    | platform font stack, neutral OKLCH ramp, light only                  | brand token set, tento-brand bindings |
```

## Shape after batch 1

```review-flow
flowchart LR
  B[browser] -->|GET / and /app/item| S[autophys-server 127.0.0.1:4794]
  B -->|GET /api/healthz| S
  S -->|index.html, main.js, style.css| D[release dir web/]
  U[systemd --user autophys.service] -->|ExecStart, Restart=on-failure| S
  F[~/.config/tento/fleet/self.toml] -->|id autophys| L[laptop tento.localhost]
  L -->|proxy| S
  class S,D,U new
  class F changed
```

The page has three stops, and every move between them starts from what is on
screen, so an interrupted move reverses without a jump:

```review-state
stateDiagram-v2
  landing: landing (deck fills the screen)
  tour: tour (app open, deck surface lowered to a peek carrying the tutorial)
  app: app (peek out of the way)
  landing --> tour: Open app / ArrowDown / URL /app/item
  tour --> app: Done / close / Escape / ArrowDown
  app --> tour: ArrowUp
  tour --> landing: wordmark / Back / ArrowUp
  app --> landing: wordmark / Back
```

- `server/` — one Rust binary crate (`autophys-server`) on crates.io axum and
  tower-http. It refuses any `--addr` that is not a literal loopback IP,
  serves `GET /api/healthz` as `{"ok":true,"version":…,"commit":…}`, answers
  `/` and `/app/...` with `index.html`, serves the built client as static
  files, returns 404 for anything else (JSON under `/api/`), and drains on
  SIGTERM.
- `web/` — plain TypeScript bundled by `deno bundle` into the ignored
  `web/dist/`. Pure logic (routes, panel state, drawer stops, tutorial
  stepper, swipe maths, FLIP maths, healthz parsing) lives in DOM-free modules
  covered by `deno task test`.
- `ops/` — `deploy.sh` builds a clean HEAD, installs it into
  `~/.local/share/tento/services/autophys/<sha7>-<yyyymmdd>/`, repoints
  `current`, renders `autophys.service` from `autophys.service.in` and waits
  for healthz to report the deployed commit. `check-flow.ts` drives the whole
  flow in headless Chrome.

Build output goes to `CARGO_TARGET_DIR=$HOME/.cache/autophys/target`; the
checkout never has a real `target/`. rwc-dev-01 has one NVMe and no external
build volume; the operator asked for this app to be built here.

## Batches

```review-table
| Batch | Content                                                                          | State |
| ----- | -------------------------------------------------------------------------------- | ----- |
| B1    | skeleton shell: repo, plan, loopback server, sidebar, header, details, tutorial, pitch deck, seamless flow, systemd unit, fleet registration | implemented, deployed (`ac0a7b1`) |
| B2+   | not defined                                                                      | pending operator direction |
```

Plan rev 1 proposed a B3 that pulled a physics core from light-scatter. The
operator ruled that out for now ("do not do the physics code from light
scatter"), so it is dropped rather than deferred; nothing after B1 is
proposed until the operator says what comes next.

## Decisions

Each of these is **agent-chosen, pending operator review**. Silence is not
confirmation.

```review-table
| Id   | Before → after | Why | Strongest alternative and tradeoff | Reversal cost |
| ---- | -------------- | --- | ---------------------------------- | ------------- |
| AP-1 | no server → crates.io axum + tower-http server, no tento vendoring | smallest dependency set that serves static files and JSON with graceful shutdown; keeps the rebuild free of fleet couplings | tento-web per the miniapp ring-2 contract: shared conventions and helpers, but pulls a tento checkout or vendored crates into batch 1 | swap the HTTP layer in `server/src/lib.rs`; small now (one router, three handlers) |
| AP-2 | no repo → standalone repo at `~/workspace/experiments/autophys`, branch master, no remote | experiments/ is the workspace's ignored home for unpublished miniapps; nothing else has to change on any host | a workspace root app or submodule: visible on every development host, but needs a workspace master inventory change (D53) on all hosts | move the directory and add it to the root inventory; cheap while there is no remote and no caller but the unit |
| AP-3 | no port → `127.0.0.1:4794` | free in the 47xx block next to hacks-inference (4790): not listening (`ss -ltn`) and not declared in rwc-dev-01 self.toml or any user unit on 2026-11-04 | another free 47xx port | edit `AUTOPHYS_ADDR` default in `ops/deploy.sh` and the self.toml entry, redeploy |
| AP-4 | — → `Restart=on-failure` | a crash or kill restarts; a deliberate SIGTERM stop stays stopped | `Restart=always`, as hacks-site uses: also restarts after a clean stop | one line in `ops/autophys.service.in` |
| AP-5 | hacks pieces on tento-ui/tento-brand → plain TypeScript and one stylesheet, no component library | the five pieces need about 1,200 lines of TypeScript and one stylesheet; the libraries they imported are far larger and carry the fleet couplings this rebuild exists to avoid | vendor the tento-ui components the pieces used (Round, IconButton, ItemList, PropertyList, std-carousel): pixel-identical to hacks-site and shared fixes, but a vendored tree in batch 1 | moderate and growing: each piece would be re-pointed at the library one at a time |
| AP-6 | hacks content → neutral placeholders: deck slides "Placeholder title for slide N", workspace items "Untitled 1–3", tutorial steps that describe only the shell | the operator has not said what autophys is; copying hacks copy would make claims for a different product | leave slots empty: honest, but an empty deck or panel cannot show that the flow works | edit `web/src/deck-data.ts`, `model.ts` items and `tutorial.ts` steps; content only |
```

## Validation

Measured results, commands and screenshots are in
[verification-b1.md](verification-b1.md). In short: `cargo test` 11 passed,
`deno task test` 9 passed, the deployed unit answers healthz with commit
`ac0a7b1`, survives a SIGKILL of its PID (systemd restarted it,
NRestarts 0 → 1), and a headless run through header, deck, tutorial,
sidebar, details, return home and a phone viewport passed 55 checks with
zero console, page or network errors.

```review-callout
note
Not measured: frame timing of the transitions (the check proves they run and
settle, not that they hold 60 fps), behaviour in Safari or Firefox, and the
page through the laptop's tento.localhost proxy, which picks the entry up on
its next registry refresh.
```

## Open question for the operator

```review-callout
note
What is autophys for? "A new physics app" names the domain, not the product.
Until that is answered the deck, tutorial and workspace items stay
placeholders, and no batch after B1 is proposed.
```

## Remaining work

- Operator answer to the product question above, then direction for B2+.
- Operator review of AP-1..AP-6.
- Confirm the app at `http://tento.localhost/#/rwc-dev-01/autophys` from the
  laptop after its next registry refresh.
- Task board: unavailable on rwc-dev-01 (no `lona task` CLI installed and no
  `~/.tento-tasks` board on this host); the B1 steps and their states are
  recorded in this page and the verification page instead.

## Scope boundary

This project owns `~/workspace/experiments/autophys`, the
`autophys.service` user unit, `~/.local/share/tento/services/autophys/`,
`~/.local/state/autophys/`, `~/.cache/autophys/`,
`~/workspace/fleet/evidence/autophys/` and the `autophys` entry in
rwc-dev-01's `~/.config/tento/fleet/self.toml`. hacks-site (owner yuzuquats)
and light-scatter are not touched.
