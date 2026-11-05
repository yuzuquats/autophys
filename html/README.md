# autophys html/: ui, client and the composition root

Imported from tento `tento-autophys-js` (tento 645a1155c, tree identical to af2eedbdc) into
this repository's `html/`: `ui/` and `client/` unchanged in place, `app/routes/*` and
`app/content.ts` now in `routes/`. Paths below are relative to `html/`.

The browser side of autophys, an investigation workbench for calibrating a simulator. You pick
a project (one simulator and its declared configuration), then an investigation. The
workbench shows its measurements, its fits (Fit, Residuals and Landscape views, plus the views
each experiment type asks for), what the data does and does not pin down (sensitivity), the
next experiment the agent proposes, and validation. The user approves, edits or rejects the
proposal.

Status: runs in tento-cookbook-js's shell against the daemon's `/api/v1/workspace` and
resumable record stream, with approval/edit/reject and device pairing. It shows a recoverable connection error when the daemon cannot load;
`?source=fixtures` explicitly selects the deterministic demo.
The sidebar status line names the active source. Same-origin requests carry the daemon's
HttpOnly session cookie; a host-injected callback renews expired sessions by reloading
the document, guarded to once per 30 seconds per tab. Missing SDK chart data stays explicitly
unrecorded. See [the UI implementation record](../autophys.project.docs/content/ui.md). The root builds against tento-cookbook-js at
561cad2f5 (see [COOKBOOK-CONTRACT.md](COOKBOOK-CONTRACT.md)). Not deployed and not pushed.

## Layout and rules (approved spec: projects/autophys.project.docs/content/architecture.md)

```text
ui/           view-only components: sidebar, main, details; charts; the view-model and intent types
client/       the logic the ui refuses to hold; imports only ui's view-model and intent *types*
  api.ts        Source { load, stream, post }, Rec, Snapshot; daemon(), firstOf(), pairing and the only network calls
  wire.ts       pure daemon record/config mapping; no simulation or network
  store.ts      the snapshot plus every record applied in gseq order; subscribe()
  records.ts    applying a decision record to a workspace (shared by the store and the fixture)
  proposal.ts   the proposal state machine; applyDecision() is the daemon's 409 rule
  derive/       snapshot + selection → SidebarModel / MainModel / DetailsModel (tree, main, details,
                charts, outlook interpolation); no simulation (AX-2)
  controller.ts Intent → selection change, a POST through the store, or a download
  fixtures/     a Source that loads a computed workspace and replays canned records, plus the
                simulators that compute it at build time
e2e/          headless browser drivers, using vendored tento-headless-js
routes/       the composition root: index.root.ts (+ index.anon.html, content.ts); tento-web
              bundles it by file name
```

- **`ui/` is view-only** (operator decision). It draws a fully derived view model and reports
  raw intents. It has no state, derivations, validation or maths beyond pixel mapping. Its
  browser adapter uses tento-ui's tree list, EmptyState, Skeleton, SelectInput, Button and icons.
  The dependency boundary lists the exact allowed modules; pure markup tests do not load DOM components.
- **`client/` holds all the logic and never draws.** No DOM, storage or network outside
  `api.ts`. Data arrives through a `Source`: `daemon()` reads the real API and `fixtures()` replays the demo.
- **`client/derive` does not simulate.** Fit curves, gain/phase, previews, landscapes,
  rankings and the proposal outlook grid all arrive in the domain. Derive formats, selects
  and interpolates.
- **Edits re-score by interpolation (E-1).** A proposal carries
  `outlook {axes ≤ 3, score[], after{param: []}}`, row-major, precomputed upstream; here the
  fixture builds it with `sim.ts`. Derive interpolates it multilinearly at the edited settings.
  An edit off the grid (or of a field with no axis, such as rate) is an invalid draft.
- Three boundary tests enforce this: `ui/boundary.deno.test.ts`,
  `client/boundary.deno.test.ts` (including planted-import cases) and the top-level layer
  test.

## The view model (what a port must deliver to `ui/`)

- **Sidebar.** `nodes: TreeNode[]` contains collapsible project roots. The legacy `switcher` field carries load state only; no dropdown is rendered. New project and a `pinned` Devices row appear above the Projects section and its tree. `connection?` and `creatingProject` carry recovery/setup state. Each node is `{id, label, icon, trail?: {text?, tone?,
  spinner?, badge?, label?}, dim?, selectable, children}`. Also `selectedId` and `expandedIds`.
- **Main.** `crumb: {label, id?}[]`, `meta`, `actions[]`, `credit`, and `body`. The body is
  one of `loading`, `onboarding`, `unavailable`, `missing`, a waiting message, or `{kind: "panels", panels: {title?, charts[]}[], columns?}`.
  A chart is one of the following kinds (or an explicit `missing` placeholder):
  - `xy`: axes, layers (dots, line, dashed line, hband, hline, vline), and an optional legend
  - `heatmap`: cell opacities plus an optional trail
  - `bars`
  - `ranges`
- **Details.** `{icon, title, cardName?, status {text, tone?}, sections: {heading, blocks[]}[],
  decision?: [Action, Action], actions?}`. A block is one of `facts`, `table`, `bars`,
  `meters`, `fields`, `links` `text` or a `missing` placeholder.
- **Intents** (`ui/intent.ts`): `select {id}`, `toggle {id, open}`, `switch {value}`,
  `action {name}`, and `field {name, raw, commit}`.

## The domain (what the daemon must deliver through the Source)

`client/domain.ts` is plain JSON:

- `Workspace {user, projects}`.
- `Project {configs[], investigations[]}`.
- `ProjectConfig`: a version and a hash. It holds the simulator, `params {unit, lo, hi,
  initial, fixed, coord}`, the experiment `catalog` (limits and `viewHints`: `envelope`,
  `frequency`, `zoom:edges`), noise, budgets, policy, `combinations` (for example k/m) and the
  `landscape` pair.
- `Investigation`: its pinned config version, `measurements` (`t`, `input`, `output`, with NaN
  for a missing sample), `fits` and `proposals`.
  - A fit carries params, χ²/N, evals, starts and basins, the residual lag-1 per measurement,
    its trail, its sensitivity (singular values and vectors, kinds, marginal std, identified
    and not identified, combos) and its landscape grid.
  - A proposal carries its fields with the original values, its status, who decided and when,
    its hypothesis, the ranking and the expected uncertainties.

Measurement ids are `<experiment>@<n>`. The SDK's identifiability rule
(`rel_tol 1e-3, max_log_std 0.1, loading_tol 0.2`) is applied in `client/fixtures/sim.ts`. Fits also
carry their `curves` and `frequency` response, validations their `predicted` series, and
proposals their `preview` and `outlook` grid.

## Fixture

| Project | Investigation | State | Mock role |
| --- | --- | --- | --- |
| Bench oscillators (m, c, k; config v1, v2) | bench A (v2) | awaiting approval | Free response leaves m, c, k on a ridge; k/m and c/m are pinned. The agent proposes a 0.44 Hz sine |
| | bench B (v1) | validated | Adding a sine identifies all three parameters. Envelope and frequency views |
| Cell pulse tests (R0, R1, C1) | cell A | running, step 12 of 40 | Fit #2 is still running. Edges view |
| Lab heaters (R, C, bias) | heater 1 | validated | Fit #1 has no sensor bias, so its residuals are structured. Fit #2 fits the bias |

Every number is computed from seeded simulations: RK4 for the oscillator, exact updates for
the RC models. Fits are Levenberg-Marquardt multistarts in the SDK's fitting coordinates, and
sensitivity is the Fisher information at the fit. The ranking reproduces page.html's order
after a free response: sine 0.44 Hz > step > sine 0.1 Hz > impulse > sine 2 Hz > repeating the
free response (≈ 0). A build takes about 0.4 s.

## Tests and build

```sh
deno test --allow-read html/                       # from the repo root (html/deno.json)
(cd html && deno check routes/index.root.ts)
autophys build-web --out <dir>/web/autophys        # tento-web bundles html/routes (html/tsconfig.json)
deno run -A html/e2e/fixture-flow.ts <base-url> <shots-dir> # 60 shell checks
deno run -A html/e2e/daemon-flow.ts <base-url> <shots-dir>  # seeded daemon, SSE, 409, pairing
```

The tests cover:

- `ui/`: markup and intent forwarding.
- `client/`: determinism and expected numbers; the fixture Source's replay, live streaming
  and 409; the state machine and decision records; trails, leaves, ridge greying and panels;
  interpolation being exact at grid nodes and multilinear between them; a lower amplitude
  scoring lower; the full round trip through Controller, Store and Source (edit, refused
  values, approve posted as `edited`, withdraw, reject, restore, each record applied once).
- All three boundary tests.

## Decisions (agent-chosen, pending operator review)

- **UI-1, the fixture computes rather than hard-codes.** Fits, sensitivity, landscapes and the
  ranking run on seeded simulations, so every number agrees with every other one. Some
  numbers therefore differ from the mocks. For example, bench A's sine leaves m at ±0.08%, not
  ±3%, at σ = 0.01 m with 1,000 samples. Reverse: lower the sample counts or raise the noise in
  `client/fixtures/fixtures.ts`. Cheap.
- **UI-2, the green ±% on a validated investigation** is the worst 2σ relative uncertainty
  among its log parameters, shown only when the held-out χ²/N is ≤ 2. Alternative: a
  prediction-error percentage on the held-out data. Cheap to change in `client/fixtures/fixtures.ts`
  `validationOf` and `client/derive/shared.ts` / `tree.ts`.
- **UI-3, edits re-score by interpolation, not recomputation** (operator decision E-1).
  Derive interpolates the proposal's uploaded outlook grid. The fixture's grid is amplitude
  (8 values) × frequency (14, including 0.44 Hz) × duration (6) at the proposal's rate,
  using the fact that a linear system's information scales with A². Rate has no axis, so a
  rate edit is refused. Adding a fourth axis would exceed E-1's limit of three.
- **UI-4, the browser can start a restricted synthetic thermal investigation.** Its
  starter uses the pinned thermal model/configuration and supports human approval,
  native resume and refitting. Use the SDK to supply arbitrary simulators and
  investigation configurations; see [contributor setup](../CONTRIBUTING.md).
