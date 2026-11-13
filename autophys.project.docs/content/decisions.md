# autophys decisions: what the operator ruled and what agents chose

Status: rev 2, 2026-11-08 (operator review of every pending agent choice). This page is the index of autophys decisions.
Operator rulings are listed with their date. Agent choices stay **pending
operator review** until `/open-questions` confirms, changes or defers them;
silence is not confirmation. Earlier decision tables are not repeated here:
AP-1..AP-8 are in [README.md](README.md), E-1a..f, SD-1 and ML-8..ML-14 in
[sdk.md](sdk.md), UI-1..UI-4 in `html/README.md`, and the store's choices in
its own page.

## Operator decisions (2026-11-04)

```review-table
| Id | Decision | Who | Where it is applied |
| -- | -------- | --- | ------------------- |
| S-1 | autophys is one product repo at `~/workspace/autophys`, a workspace submodule with the private remote `github.com/yuzuquats/autophys` | operator, 2026-11-04 | `.gitmodules` in the workspace repo; this repo |
| S-2 | the daemon is a tento-web app on its file-based router; the routes, the ui and the client live in `autophys/html/` | operator, 2026-11-04 | `src/app.rs`, `src/server.rs`, `html/` |
| S-3 | tento's `tento-autophys-js` may be removed from tento master once imported here | operator, 2026-11-04 | import done in this repo; the tento removal is the orchestrator's, not yet made |
| N-1 | the cookbook's public API is one `Cookbook` namespace (`Cookbook.mount(…).run(app)`, `Cookbook.View.mount`) | operator, 2026-11-04 | `html/routes/index.root.ts`; `tento-cookbook-js` |
| E-1 | an edited proposal is re-scored by interpolating an outlook grid the SDK precomputes (at most 3 axes); nothing simulates in the browser | operator, 2026-11-04 | `sdks/python` (sdk.md), `html/client/derive` (UI-3) |
| O-3 | whether the UI approves device pairings or only `autophys pair approve` on the host | operator, 2026-11-04 | **both**: a pairing can be approved in the UI and with `autophys pair approve` on the host. The keyless state-changing routes the UI uses require `Content-Type: application/json` (otherwise 415) and an `Origin` equal to the daemon's own origin (otherwise 403) | `src/http` pairing routes (store agent); Devices UI section to follow |
| AX-1 | the cookbook hands out slots; it never asks for components | operator, 2026-11-04 | `architecture.md`; `html/routes/index.root.ts` |
| AX-2 | numerics live in the SDKs only; the client formats. **Revised 2026-11-04:** both SDKs carry the numerics (full API parity, `rust-sdk.md`); Python is the numerical reference. Originally: the Python SDK only | operator, 2026-11-04 | `html/client/derive`, `sdks/python`, `sdks/rust` (phase 2) |
| AX-3 | one SQLite file: an append-only record log with projections derived from it | operator, 2026-11-04 | `src/store` (store agent) |
| AX-4 | live updates are SSE with a `gseq` cursor | operator, 2026-11-04 | `src/http` (store agent), `html/client/api.ts` |
| AX-5 | loopback only, reached through tento.localhost | operator, 2026-11-04 | `src/server.rs` `parse_loopback` |
| AX-6 | the name on disk is `autophys` everywhere new | operator, 2026-11-04 | binary, unit, dirs, SDK |
```

Two further operator rulings arrived through hackathon/lib during the
restructure (relayed, 2026-11-04): autophys builds against a vendored tento
tree at `vendor/tento` (`vendor/` is not edited here), and the
restructure lands as **structure** commits (reviewed and pushed) with
**logic** commits stacked on top (kept local).

## Agent choices from the restructure (pending operator review)

Implemented in this repo's restructure commits (Change-Ids below). Each is
cheap to reverse unless it says otherwise.

```review-table
| Id | Before → after | Why | Strongest alternative and tradeoff | Reverse (cost) |
| -- | -------------- | --- | ---------------------------------- | -------------- |
| R-1 | B1 served `web/dist` → a dev `serve` bundles into `~/.cache/tento/autophys/web/local.web`; deploy builds `<release>/web/autophys` and serves it with `--web-root` | tento-web puts its per-file module store two directories above the tree; this shape keeps it inside the app's cache and inside each release | paper-reader's `<crate>/target/local.web`: a real `target/` in the checkout, which the fleet rule forbids | change `default_web_root` and two lines of `ops/` (minutes) |
| R-2 | B1's axum `/app/*` fallback → two actix routes in `app.rs` return the built `routes/index.anon.html` for `/app` and `/app/<item>` | the cookbook needs both addresses to load the shell; the file router only knows `/` | a `{tail}` route directory under `html/routes/app/`, which duplicates the shell file | delete two routes (minutes) |
| R-3 | (new) `autophys build-web` exits 1 when tento-web's `build-status.json` reports bundle errors; per-file emit errors are a warning | tento-web returns `Ok` from a failed build, so a deploy could ship a page without its bundle. The per-file `?fe=unbundled` tree is unused here; it failed when tento sat outside the project (it passes against vendor/tento) | fail on emit errors too: stricter, and a relocated tento would block deploys | one function, `check_build_status` (minutes) |
| R-4 | brief's compiler deps `html`, `../tento/…` → `.`, `../vendor/tento/tento-cookbook-js`, `../vendor/tento/tento-ui-js` | tento-web resolves compiler deps against the html root, not the project root; `html` made the dev watch panic on `html/html` | none: this is how tento-web reads them (paper-reader never runs the watch) | n/a |
| R-5 | `/api/*` outside healthz → a JSON 404, as B1 had; it sits after the `/api/v1` hook | API callers never get the HTML page or a plain 404 | let the file router answer, as paper-reader does | delete two routes (minutes) |
| R-6 | tento's `README.md` would overwrite this record's cover → it is imported as `tento-plan.md`; the cover stays this repo's `README.md` | both files are named README.md; this repo's cover is the newer, current one | replace the cover with tento's page: loses B1's record and AP table | rename (minutes) |
| R-7 | tests ran from tento's root `deno.json` → `html/deno.json` maps the same aliases into `vendor/tento` for `deno test`/`deno check`; `html/tsconfig.json` does it for esbuild | Deno does not read tsconfig paths, and tento-web's esbuild does not read deno.json | one root `deno.json` beside `Cargo.toml` | move one file (minutes) |
| R-8 | (new) `e2e/approve.ts` serves on 127.0.0.1:4795 and drives deck → app → proposal → Approve in Playwright's arm64 Chromium through puppeteer-core with `pipe: true` | `tento-headless-js` failed on this aarch64 host; pipe mode ties Chrome to the script | the cookbook-era `ops/check-flow.ts`, which targets the placeholder app | delete the file (minutes) |
| R-9 | B1 recorded tento HEAD as TENTO_COMMIT → deploy records `git rev-parse HEAD:vendor/tento`, the vendored tree's id | the bundle is built from vendor/, not the tento checkout; the tree id names exactly those bytes | keep reading `~/workspace/tento` HEAD: names a commit the build never read | one line (minutes) |
```

Change-Ids: structure I96ab4c4e17d7071c6395 (crate), Ic0facb30ce209809407a
(html shell), I1efebbcd898d11d732c3 (ops); logic Ied3ec9ce88d8d9cc98cb
(daemon routes, CLI stubs and tests), Icf889ee79ded95e3c6a3 (html import);
this record I81f7837f7c0ee007ff06.

## Operator review, 2026-11-04 (`/open-questions`, autophys/rs)

```review-table
| Id | Decision (operator, 2026-11-04) | Before | Implementation |
| --- | --- | --- | --- |
| AX-9 | **Changed: session cookie.** The served page sets a random, HttpOnly, `SameSite=Strict` cookie, and `/workspace`, `/stream` and `GET /pairings` require it. The `Sec-Fetch-Site` keyless-read exemption is removed. Keys still work for every other client. | keyless same-origin reads on a loopback bind | implemented in phase 1 (rust-sdk.md) |
| AX-10 | Confirmed: a replayed id returns the stored record with 200; the same id with different content gets 409 `idempotency_conflict`. The Python fake follows the store. | — | built in the store; Python fake to follow (autophys/api) |
| RS-1 | Confirmed: the library crate is `autophys` (`use autophys::connect`); the root package is `autophys-cli`, binary `autophys`. | — | implemented in phase 1 (rust-sdk.md) |
| AX-17 | **Changed: the server's default collection is `AUTOPHYS_HOME`, else `~/autophys`, the same as Python's.** The keys and pairing database lives in `~/.local/share/tento/autophys/`. | one database at `~/.local/share/tento/autophys/autophys.db` | implemented in phase 1 (rust-sdk.md) |
| R-9 | **Changed: drop `tento_commit`.** `/api/healthz` is `{ok, version, commit}`, plus `web_id` once the app is bundled; deploy stops writing `TENTO_COMMIT`. | `tento_commit` held the vendored tree id | implemented in phase 1 (rust-sdk.md) |
| batch | Confirmed as built: AP-3 (port 4794), AP-4 (`Restart=on-failure`), AP-8 (cookbook through the vendored alias), AX-8, AX-11, AX-12, AX-13, AX-14, AX-15, AX-16, R-1 to R-8. | — | built |
| B-1 | Operator direction: `./autophys` ships as one file per platform with the web app embedded as a ZIP, so no folder travels with it; one binary for every OS is not needed. Linux appends the ZIP with a footer; macOS puts it in a Mach-O section. | `--web-root` folder beside the binary | implemented: embedded ZIP locator, safe atomic hydration, pack/build-web and serve; Linux round-trip, concurrency and socket tests pass; tento_sh command tree implemented; macOS section/link path untested on Linux |
```

## Operator review, 2026-11-04 (`/open-questions`, second round)

```review-table
| Id | Decision (operator, 2026-11-04) | Reason | Implementation |
| --- | --- | --- | --- |
| RS-CURSOR-1 | Confirmed: the unscoped stream keeps a per-project cursor vector (`prj_…:<gseq>,…`); no global server sequence | no writes across workbook files and no server index to recover; scoped streams keep integers | built (phase 1) |
| B1-M1 | Confirmed: macOS `pack` keeps relinking with `-sectcreate`; **add a real macOS check** (section present, signature valid, `serve` hydrates) before relying on it | the linker signs the result; a build-time link stage adds a step for no current gain | built; macOS check not yet run |
| CVE-MERGE | Confirmed (workspace project `cve-2026-98432`, commit 550026e8): the additive merge of the 148-line history and the 2026-11-03 status and monitoring section stands | it changes none of the owner's text | committed locally on rwc-dev-01 workspace master, not pushed |
```

## Display manifest, 2026-11-04 (autophys/ui)

```review-table
| Id | Decision | Who | Where it is applied |
| --- | --- | --- | --- |
| DM-1 | The UI holds no product knowledge. Simulators declare a display manifest (channels, setting roles and units, views, input previews), uploaded with `PUT /projects/{pid}/display` outside `config()` and its hashes, and one compiled UI renders any product from it. Approved as written in [display-manifest.md](display-manifest.md) rev 2, with implementation handed to autophys/py (SDK, goldens) and autophys/rs (daemon, Rust SDK) | operator, 2026-11-04 ("autophys should be generic"; "have autophys/py and autophys/rs implement") | `sdks/python`, `src/http.rs` and the workbook, `sdks/rust`, then `html/client` |
```

## Purpose, 2026-11-04

```review-table
| Id | Decision | Who | Consequence |
| --- | --- | --- | --- |
| PURPOSE | autophys is a **general physics-investigation workbench**, not a battery-calibration product. Battery is one example domain beside oscillator and thermal_rc | operator, 2026-11-04 (relayed from the progress-review thread) | unblocks B2 planning; B2 includes the generic display-manifest contract (DM-1): Display type and `PUT /projects/{pid}/display` outside the config hash. Rust SDK and daemon parts are autophys/rs's |
```

## Fit curves and ground truth, 2026-11-04 (autophys/design)

```review-table
| Id | Decision | Who | Consequence |
| --- | --- | --- | --- |
| FC-1 | A `run` record carries `curves`: the model simulated at the fitted and at the initial parameters, per trained or predicted measurement, downsampled to at most 2,000 points. The Fit tab adds a residual strip under each chart, and the Residuals tab works from the same data. Reason: the UI does no numerics and the daemon does not read payloads, so only the SDK can produce the curves. Strongest alternative: compute the curves on demand through a daemon endpoint that calls the SDK, which keeps the workbook smaller but needs a live SDK just to view a run. Reversal: drop the field; it is optional, so nothing breaks | **operator, 2026-11-08: confirmed as built** (`/open-questions`; agent recommended keeping) ([fit-curves-and-truth.md](fit-curves-and-truth.md)) | `sdks/python`, `sdks/rust`, `html/client/wire.ts`, `derive/charts.ts` |
| FC-1r2 | Rev 2 of fit-curves-and-truth.md: Rust's fit curves match Python's within numerical tolerance (`rtol=1e-5, atol=1e-8`), not byte for byte, because two independently solved ODEs cannot agree to the byte; `reveal` records stay byte-for-byte identical | **operator, 2026-11-04** (relayed) | no code change; `sdks/rust` conformance tests keep the tolerance for curves and exact bytes for reveal |
| GT-1 | Synthetic and benchmark investigations append a `reveal` record after `outcome`: per identifiable quantity, the truth, the estimate, the ratio, the ±1σ ratio and whether it is within tolerance. The UI shows a Ground truth page. An SDK refuses to resume an investigation once it has a reveal. Reason: this keeps the truth hidden from the agent by construction. Strongest alternative: show the truth only in the offline `research.py` scores, which needs no new record kind but leaves no page to look at. Reversal: drop the kind and the endpoint; there is no migration, because older workbooks have no reveal | **operator, 2026-11-08: confirmed as built** (`/open-questions`; agent recommended keeping) | `synthetic.py`, `bench.py`, daemon kinds and endpoint, `html/client` |
```

## License and first release, 2026-11-07

| ID | Decision | Source | State |
| --- | --- | --- | --- |
| LIC-1 | autophys is dual licensed **MIT OR Apache-2.0**: root `LICENSE-MIT`, `LICENSE-APACHE` and `NOTICE`; the root and Rust SDK manifests and the Python SDK (with its own copies of both files) declare that expression. Before: Cargo said UNLICENSED, Python said Apache-2.0 with no text, and vendor/README.md listed this as a release blocker. | operator, 2026-11-07 (chose the recommended dual license) | implemented |
| LIC-2 | The `vendor/tento` copy of the operator's Tento libraries is licensed under the same terms through the root `NOTICE`. Vendored bytes stay unchanged (no license fields are added to their manifests); crates that already declare MIT keep it. Patched third-party crates and the prebuilt editor bundles keep their own licenses (`licenses/web-editors.txt`). | operator, 2026-11-07 (granted for the autophys copy only; tento's own repository is unchanged) | implemented |

## Field test v0.1.1, 2026-11-07 ([field-test-v011.md](field-test-v011.md))

| ID | Decision | Source | State |
| --- | --- | --- | --- |
| UNC-1 | The recorded `analyze_sensitivity` step result gains `marginal_log_std` (per-parameter one-sigma log uncertainty; `null` for the report's `inf`), in both SDKs, and the workbench falls back to the recorded identified/not-identified verdict when no uncertainty is recorded. Before: the step recorded only the verdict and the UI ignored it on the finished summary, calling identified parameters "unbounded". Reason: the number already exists at record time and the change is additive, so old workbooks keep working. Strongest alternative: record the full report (singular values and vectors) so the daemon path matches the fixture path, which also fills the Identifiability card but grows every step record and the record contract further. Reversal: drop the key from both SDKs and `wire.ts`; nothing else reads it, and the verdict fallback stays useful on its own | **operator, 2026-11-08: confirmed as built** (`/open-questions`; agent recommended keeping; the full report can be added later, additively) | implemented |
| ANA-1 | Projects gain an `analysis` config section; `analysis.identify_every_fit` (default **true**) runs the identifiability check, with each parameter's ±, right after every adopted fit in both SDKs, charged to the simulation budget, and records it as `identification` in the result of the step that made the fit (`optimize_parameters`, `compare_models`); a check the budget cut short records `{"skipped": ...}`. The section is in the config only when changed, so existing config versions keep their hash (and pick up the default). Before: ± existed only where the policy ran a separate `analyze_sensitivity` step (UNC-2, open). Consequences: the scripted policy no longer spends a step on `analyze_sensitivity`; resume rebuilds the paid-for sensitivity off budget; the numeric run transcripts and step-count tests were re-baselined; the historical Spark recording still replays request by request. Placement: step result rather than the `run` record, because released Python SDKs (≤ 0.1.2) reject unknown `run` keys on resume. Strongest alternative: leave it to the policy (old behavior; set the switch false). Reversal: set the default to false in both SDKs (configs then gain no key; trajectories return to the old shape). | operator, 2026-11-07 ("let's organize some project config and default to true"; named `analysis.identify_every_fit` on agent recommendation, confirmed "go ahead") | implemented |

## Build cache, 2026-11-07

| ID | Decision | Source | State |
| --- | --- | --- | --- |
| BUILD-1 | autophys keeps **one** build cache per host: the checkout's gitignored `target/`. `ops/deploy.sh`, `release.sh`, `package.sh` and the macOS `pack` relink default `CARGO_TARGET_DIR` to it instead of `~/.cache/autophys/target`; CONTRIBUTING no longer asks for separate external storage. Before: yuzuquats held three full caches (`~/.cache/autophys/target` 52 GB, `~/ssd-mount/cargo-target/autophys` 35 GB, `autophys/target` 1.6 GB) plus a 16 GB `~/.cache/autophys/review-target`, all on the boot disk at 98%. The extra trees were deleted (disk 98% to 86%). `CARGO_TARGET_DIR` still overrides; older pages that name `~/.cache/autophys/target` are historical. | operator, 2026-11-07 ("just keep the single canonical autophys/target") | implemented |


## Operator review, 2026-11-08 (`/open-questions`)

The operator chose to review the workbook-data and SDK-contract choices one
at a time, and to confirm the CLI, UI, layout and productionize-method
choices from one summary table per group.

| Id | Decision (operator, 2026-11-08) | Implementation |
| --- | --- | --- |
| FC-1 | Confirmed: fit curves stay in `run` records (not computed on demand), so old runs stay viewable without a live simulator | built |
| GT-1 | Confirmed: the `reveal` record after `outcome`, the Ground truth page and the resume lock stay | built |
| UNC-1 | Confirmed: one `marginal_log_std` per parameter; the full identifiability report is not recorded unless the UI later needs it | built |
| DM-D1 | **Changed: format 2.** The display table becomes a coordinated format-2 workbook migration in both SDKs instead of an optional table in format 1; released SDKs (<= 0.1.2) will refuse format-2 workbooks. Agent recommended keeping format 1. Open sub-question **DM-D1a** (ask before implementing): both SDKs migrate on open today, so one open with a new SDK would lock any workbook out of 0.1.x; upgrade on open, or only when a display is first written | built: format 2 in both SDKs and the daemon, reached at the first display write (DM-D1a); Python `68536e9`, Rust and daemon `e0bf786` |
| CORE-01 | **Changed: a generic batch API.** A general multi-record transaction endpoint replaces the dedicated attachment route. Agent recommended keeping the dedicated route with no fallback. Open sub-question **CORE-01a**: whether the shipped `/proposals/{pid}/attachment` route stays as a compatibility alias | built: `POST /investigations/{inv}/records` (all or none, idempotent by record id); the attachment route is removed (CORE-01a) and SDK 0.1.0 to 0.1.2 cannot attach against this daemon; `b116ef4` |
| CORE-02 | Confirmed: refuse configuration drift before run/approve/attach/resume; one investigation, one config. Finding A3 (tools that bypass the check) stays open | built |
| CORE-03 | Confirmed: normalise equivalent daemon URLs, reject ambiguous targets before effects, scope saved keys to the normalised identity | built |
| CORE-04 | **Changed: unify on open.** `project(name)` opens an existing project and errors if missing in both SDKs; Rust callers that rely on create use `ensure_project`. Agent recommended this (beyond the additive pair that was built), for AX-2 parity at 0.x | built: Rust `project(name)` opens (404 if missing); `ensure_project` creates; `Ib8f521611f865d8ff5462fa64020266c` |
| RS-REMOTE-1 | **Changed: async API.** The Rust remote transport moves from blocking `ureq` to an async (tokio) API. Agent recommended keeping blocking with async added beside it later. Open sub-question **RS-REMOTE-1a**: whether a blocking wrapper stays for scripts. Build CORE-01's batch API on the new transport | built: async reqwest/tokio `autophys::remote::Remote` plus the `autophys::blocking` facade (RS-REMOTE-1a); `199c4fb` |
| RS-REMOTE-2 | **Changed: both SDKs error.** A daemon without `reveal` or `display` gives a clear upgrade error in Python as in Rust; Python stops warning and skipping (agent recommended this) | built: Python `dac03c9`; Rust gives the same upgrade wording for reveal, display and batch appends, `e0bf786` |
| DM-RS-1 | **Changed: explicit struct.** Rust `Trajectory` drops its map `Deref`/`DerefMut` for typed `outputs()`/`inputs()` accessors and channel lookups that return an error naming the channel; inputs are serialised and compared like outputs. Operator asked which direction gives stronger types; agent recommended this. Open sub-question **DM-RS-1a**: serialising inputs changes a `Trajectory`'s JSON; check record and hash contracts first | built: typed accessors, serde `{"y", "u"}` (DM-RS-1a); `f88704d` |
| O-3a | Confirmed: keyless browser writes accept only the bound loopback origins plus explicit `--browser-origin`/`AUTOPHYS_BROWSER_ORIGINS`; **deploy and the tento.localhost wrap step should pass the host's exact origin** | built: the allowlist, and deploy renders the tento.localhost origin into the unit (`I7d2a5e8c1b4f93062a7d5e1c8b3f4a29`), effective at the next deploy |
| E-1a | Confirmed: zero-axis (scalar) outlooks are allowed; an axis with no values is refused | built |

store.md's AX-8 to AX-17 callouts still read "pending operator review"; they were settled on 2026-11-04 (the batch and AX-9/AX-10/AX-17 rows above), and that wording is stale.

### Groups confirmed from summary tables (operator, 2026-11-08)

| Group | Ids | Decision | Implementation |
| --- | --- | --- | --- |
| CLI | CLI-4, CLI-5, CLI-6, CLI-7, CLI-9, CLI-12, CLI-13, CLI-14 (cli.md) | Confirmed as built. CLI-12 means Rust-era bench scores are not directly comparable with Python-era ones | built |
| UI | UI-5 to UI-20, INV-1 to INV-4 (investigation-page.md), LC-01 (approval-header.md), UI-approval-rows-1 and the row defaults (ui-refinement-implementation.md), drawer DM-1 (drawer-motion.md) | Confirmed as built | built |
| UI-27 | New project (ui.md) | **Changed: SDK stepper only (option C).** New project becomes a three-step SDK flow: `autophys new --lang python\|rust`, `autophys connect <daemon> --name <device>` with the pairing code approved in place, then the first investigation appearing. The built-in Thermal wizard is removed and not kept as a demo. Operator saw mocks of A (today), B (SDK plus Try a demo, agent-recommended) and C | **implemented** (`Ie4f804d3ea81ab924611f3d5cefc1bc9`, `I3babbef47e5b61f8fedbdc0df2ea9a62`); the daemon's `/workbench` starter API removed too (`I6d08b4d44d86063ab2714e7dbc4f4151`); agent choices UI-27-a..e in ui.md pending review |
| Layout and packaging | OSS-1 to OSS-3 (oss-layout.md), AP-5 to AP-7 (tento-plan.md), MP-1 and MP-3 to MP-6 (muse-plugin.md) | Confirmed as built; MP-5 (battery-only CSV import) may widen later with the display manifest | built |
| Productionize method | W-1, PP-1, R1-D1, R1-D2, R2-D1, R2-D2, R2-D3, R2B-D1, R2B-D2, R2-PY-D1, R3A-D1, R3B-D1, SP-1 | Confirmed as built; budgets stay diagnostics, not SLOs | built |
| Battery cases | BT-1 to BT-4 (sdk.md) | Confirmed as built | built |
| Research-loop proposals | AR-2, AR-4, AR-5 (sdk.md) | **Deferred** to the research loop's first real run, together with EX-11's switch to drawn truth | not built |

The per-page "agent-chosen, pending operator review" wording for every id
above is stale; this register is authoritative.

### Sub-questions settled (operator, 2026-11-08, third `/open-questions` pass)

| Id | Decision | Facts it rests on |
| --- | --- | --- |
| DM-D1a | **A workbook becomes format 2 when its first display is written**, not on open; v2 means the display table exists, and display-less workbooks stay format 1 and readable by SDK 0.1.x (agent recommended) | Rust and the daemon migrate on every writable open (`sdks/rust/src/schema.rs`), so upgrade-on-open would convert a whole collection as soon as a new `autophys serve` touched it; Python has no migration step yet and needs one either way |
| DM-RS-1a | **A serialised Rust `Trajectory` is `{"y": {...}, "u": {...}}`**, the worker protocol v1 shape (agent recommended) | no record or hash serialises a `Trajectory`: fit curves (`curves.rs`) and the worker protocol (`worker.rs`) build their JSON explicitly; the serde shape is public API only |
| RS-REMOTE-1a | **One async transport plus a thin blocking facade** (`autophys::blocking`, like `reqwest::blocking`); the CLI, the investigation loop and scripts use the facade (agent recommended) | every current caller (CLI commands, investigation loop, simulator and fit traits) is synchronous |
| CORE-01a | **Remove the old attachment route**; only the batch endpoint remains. Agent recommended keeping a deprecated alias | v0.1.0 to v0.1.2 call `POST /investigations/{inv}/proposals/{pid}/attachment` with no fallback, so they cannot attach data against a daemon without it and must upgrade |

### Build choices reviewed (operator, 2026-11-08, fourth `/open-questions` pass)

The agent choices recorded while building the review decisions
([review-20261108-implementation.md](review-20261108-implementation.md),
[ui.md](ui.md) UI-27-a..e).

| Id | Decision | Implementation |
| --- | --- | --- |
| DM-RS-1b | **Changed: remove `Index<&str>` from Rust `Trajectory` now**; only the `?`-returning accessors remain. The operator accepted the one-time cost: the built-in models' test code changes, so their source hashes and every bench project's config version move once (config drift shown on the next run). Agent recommended keeping it until a release that moves those hashes anyway | built (`I557040dea5ba1c992c8773410e81a509`) |
| RR1-b | **Changed: new `data_attached` records carry the measurement record's hash in `measurement_version` in both SDKs** (Python stops writing the dataset version integer). Readers keep accepting integer records already written. The Python change is in `agent.py`, coordinated with the peer session editing it (agent recommended) | built (`I637818e1325e675028c76cc9a17442d2`) |
| CORE-01-a..e, RR1-a | **Confirmed as built**: `POST /investigations/{inv}/records`, `hash_of`, per-record replay with mixed batches, the 64-record cap, general per-record rules, and the preceding-measurement link rule (its payload-version branch stays for older clients) | built, published |
| RS-REMOTE-1-a..c, RR1-c | **Confirmed as built**: reqwest 0.12, `blocking` always compiled, one shared runtime plus a helper thread inside another runtime, TLS provider not pinned (process default, else ring) | built, published |
| RS-REMOTE-1-d | **Changed: reuse connections** on the shared, process-lifetime runtime instead of one connection per request, after confirming every call path runs on that runtime; each request to a remote https daemon otherwise pays a new TCP and TLS handshake (agent recommended) | built (`I0a528c9c3083cb40cc8a246ba61cf108`) |
| UI-27-a..e | **Confirmed as built**: runnable placeholder names, Thermal start button removed, completion rule, workspace re-read on the existing poll, native toggle buttons | built, deployed, published |

### Implementation follow-ups from this review

All eight were built on 2026-11-08; see
[review-20261108-implementation.md](review-20261108-implementation.md). Commits
are named there by Change-Id, since local history may be restacked before it
is pushed.

## Positioning copy, 2026-11-08

Review: `fleet/evidence/autophys-positioning-review-20261108/` on rwc-01
(`review.md`, Muse Wonder's `muse-review.md`; a Claude subagent graded the
slide-6 chart). The operator asked to highlight Muse Spark and Muse Wonder and
said "go ahead" on the shown before/after.

| ID | Decision | Source | State |
| --- | --- | --- | --- |
| POS-1 | The hero leads with the agent and the check: "Muse Spark plans the experiment. Autophys checks the claim." Its stats are real or guaranteed (8 / 8 live runs by Spark 1.3 and by Wonder 1.0, ±10% at 1σ, every test approved by a person in the workbench) instead of the mock "6.3× fewer test hours" and "12 held-out cells". The docs name Spark as the default driver and Wonder as the playbook improver. | operator, 2026-11-08 ("we should highlight muse or wonder specifically", "go ahead") | implemented |
| POS-2 | Slide 6 replaces the mock test-hours chart with the recorded Spark 1.3 discovery pass (seed 0, six cases), drawn by a new `cases` deck body in `vendor/tento/tento-cookbook-js`. The pass comes from the experimental `autophys.discovery` package, so the slide is only as public as that package. Strongest alternative: three stat tiles (0 false claims, 1 wrong claim alone, 1 recovered structure), which read faster but drop the per-case error. Reversal: restore the `lines` slide or swap the body; the `cases` kind can stay unused (minutes). | operator-confirmed 2026-11-08 (/open-questions: keep the per-case chart) | implemented |
| POS-3 | The product name stays "Autophys" (header, page title, `app.title`); the review's "AutoPhys" spelling is not adopted, so the deck and header agree. Reversal: change `index.root.ts` `title` and the README (minutes). | operator-confirmed 2026-11-08 (/open-questions: keep "Autophys") | implemented |

**POS-4, case studies and experiments section** (operator-confirmed 2026-11-08 in /open-questions: keep the not-run candidates).
Before: the landing ended at the docs. After: a section below them, behind the same
full-width divider, lists what has been run (battery 1RC live, the Spark discovery pass,
mass-spring-damper and thermal RC offline) and three highlighted candidates not run yet
(lithium-iron cells across temperature, a building thermal envelope, reaction kinetics),
each with why it fits and what it needs. Recommendation: name candidates by the fit
criteria (a few named parameters, tests costing hours or days, parameters an easy test
confounds) so readers can judge them. Strongest alternative: list only what has run,
which avoids any appearance of a claim but hides where the product is meant to go.
Candidates claim no results. Reverse by dropping `html/routes/studies.ts` and its two
lines in `index.root.ts` (minutes). The docs' discovery sentence now says the package is
in development, because `autophys.discovery` is not on this master.

**Publication, 2026-11-08.** POS-1..4 were pushed to `origin/master` as a fast-forward
`fe522fb..818aa7f` (Change-Ids I594f8b25, If71c04a1, I40405426, I014f1892, If84e22a3,
I29f80ed3, Iae228d8b, Idc370c31, Id27f5b23). Agent review only, not an operator verdict:
round 1 asked for changes (planted offset was mislabelled a stale fit; the record shows
Spark's three adopts were refused and the root fit stood; plus copy fixes), all fixed in
818aa7f; round 2 returned ready on 818aa7f. Checks on an export of 818aa7f: deno check,
141 html tests, 22 cookbook tests. Open: no unit test for the `cases` body;
`vendor/patches/autophys-bundler-context/verify.py` already fails at fe522fb because the
vendored cookbook no longer matches either pinned manifest.

**Production, 2026-11-08.** `818aa7f`'s web was deployed at 18:27 as a web-only release on
the v0.1.4 binary (`fe522fb-web-818aa7f-20261108`, healthz web_id `09d582e0…`; see
[release.md](release.md)). An independent agent review of `fe522fb..818aa7f` before that
deploy found two blockers, fixed in forward commits: the slide 6 note and the discovery
study said "five invalid adopts and one unproven stop", where the Spark seed 0 record shows
11 refused adopts and more than one demoted stop (copy now: "refused 11 invalid adopts and
demoted the stops the data did not support"); and the `cases` chart overflowed phones, so
below 640px it now stacks each case's name and outcome above its rail with the
calibration-alone outcome below. Those fixes reach production with the next deploy.

## Case study deep links (operator decisions, /open-questions 2026-11-08)

| Id | Decision | Decided by | State |
| --- | --- | --- | --- |
| DL-1 | A generic deep-link scheme rather than a studies-only list: links read `/open/<user>/<kind>/<name>`; the page probes the link with `HEAD` and shows its button only when the answer is not 404. `GET` redirects into the app and selects the target. | operator ("can we build a generic deeplinking scheme? the fe checks if the link/asset is 404") | deployed to autophys.lona.so 2026-11-08 (release `1d5d193-20261108`): `src/open.rs` serves `HEAD`/`GET /open/{user}/{kind}/{name}` (`KINDS` table; kind `workbook`, name = the workbook slug, checked as a file stat). `HEAD` 200/404 with `no-store` and no body; `GET` 302 to `/app?open=…` or a plain 404; any other `/open` path is a 404, never the app shell. The page (`html/routes/open-address.ts`, `open-link.ts`) selects the workbook's newest validated investigation, else its config node, and drops a missing one quietly. Studies probes each run study's link and shows "Open in workbench" on 2xx only. |
| DL-2 | The user part uses reserved names: `demo`, `me`, and `local` on login-off installs. No schema change; unique `@handles` can take the same slot when sharing exists. The probe answers 404 for anything the caller cannot open, so it never reveals another account's workbooks. | operator (reserved names; asked that links include a user scheme) | deployed to autophys.lona.so 2026-11-08 (release `1d5d193-20261108`): `demo` (404 without `--login` or a demo account), `me` (the caller's own; 404 signed out; agent choice: the local collection on a login-off install), `local` (login-off only); every other name, including account ids and emails, is 404. |
| DL-3 | A signed-in visitor following a `/open/demo/…` link is asked to switch to the demo (signing out of their workspace) before it opens. A light access rule makes the demo account's collection public: anyone may probe it and switch into it; every other collection answers only its owner. The rule is derived from `users.demo`, with no new column. Reading the demo alongside one's own workspace stays a later option that keeps the same links. | operator ("confirm, then switch - we'll need some light acl so that the demo account is public") | deployed to autophys.lona.so 2026-11-08 (release `1d5d193-20261108`): `open::may_open` (public when `users.demo`, else owner only; an inactive demo is not public). The app context gains `workspace.demo` so the page knows whether it is already in the demo. Signed out, the page posts `/api/auth/demo` as a form navigation back to the link (a 30 s per-tab guard stops a retry loop); signed in elsewhere, a dialog asks "Switch to the demo workspace?" and signs out first. |
| DL-4 | Add mass-spring-damper and thermal RC demo workbooks, generated from the offline benchmark runs, to the demo collection: dev's demo books first, prod's `/home/james/autophys` (demo-only; the operator's account uses its own workspace) after the operator looks. Model discovery gets none until its package is released. | operator (add both, dev first) | done 2026-11-08: `ops/demo_workbooks.py` (offline scripted policy, seed 0, `--by demo-generator`) generated `mass_spring_damper_demo` (inv_f9937c62fb18ecf0, validated, chose sine_0.44Hz) and `thermal_rc_demo` (inv_c393efe1a93f5e94, validated, chose a 600 s pulse). Copied into dev's demo books, then prod's `/home/james/autophys`; `verify` ok for all three demo workbooks. |

The server pieces (the `/open` route, the probe and the access rule) change Rust, so production needs a native build, not the web-only redeploy.

### Publication and deploy receipt, 2026-11-08

- Pushed to github.com/yuzuquats/autophys master `a43ed9b..725f629` (fast-forward, explicit refspec), 9 commits: f582cf8, afdbc6f, 31c00ba, 7c54f69, 484b48d, 693056c, 7ab697e, fa2b9dc, 725f629 (Change-Ids I5346…, I59ad…, I12a5…, Icc28…, I9e40…, Iaca4…, Ib1c7…, Idaec…, I1ede…). Five peer commits stay local above it.
- Agent review: three rounds (general-purpose Opus subagents, read-only). Rounds 1–2 found the stale-fit label, copy errors, the login-off gate (any local page could probe `local`), switch-before-probe, the aria label and a cross-site existence leak; all fixed in the owning commits or fa2b9dc/725f629. Round 3: **ready**, patch-ids matched round 2's lineage. Non-blocking residual: `<object>`/`<iframe>` loads are also `Sec-Fetch-Mode: navigate`; fixed in the follow-up below (local, unpublished).
- Checks on an export of 725f629: `cargo test --locked` all green (`tests/open.rs` 2/2); `deno check`; `deno test` 144 pass, 1 fail = `html/boundary.deno.test.ts:12`, which fails identically on a43ed9b (a peer's `html/app-switcher/` dir).
- Production: native release `~/.local/share/tento/services/autophys/1d5d193-20261108` (tree identical to local master at the time; 725f629 plus the five peer commits), web_id f2d0fc8c…, rehearsed on :4793 with temp state. Unit backup `autophys.service.pre-1d5d193-20261108`; rollback release `fe522fb-web-7059330-20261109`. Public checks: healthz commit 1d5d193; `HEAD /open/demo/workbook/{battery_cycler_demo,mass_spring_damper_demo,thermal_rc_demo}` 200, missing 404, `/open/me/…` signed out 404, GET 302 to `/app?open=…`; a signed-out click on Studies' Thermal RC button signs in as the demo and opens inv_c393efe1a93f5e94.
- Dev (dev--autophys.lona.so) still runs the older native binary with a newer web build, so its Studies buttons stay hidden until a native dev deploy.

## Project overviews (agent choices, 2026-11-13, pending operator review)

OV-1 to OV-5 are in [overview-sdk.md](overview-sdk.md) under Rules. OV-6 to OV-11, chosen
during implementation, are in its Result section.

## Lona family app switcher (agent choices, 2026-11-08, pending operator review)

The header's brand link now carries the Lona family app switcher (operator
request, 2026-11-08: "add this in for autophys as well … configured during
packaging … checked in .json and .env"). Files: `html/.env.example`,
`html/routes/app-switcher.ts` and the gitignored `html/app-switcher.json`
(since 2026-11-09, AS-3); tento commits `6704015634` and `6ac37afcce` on
yuzuquats tento master (project fleet-brand-rollout), vendored here, and
`c31a3a2d12` (the Lona look as a data preset), vendored as repin-20261109c.

```review-table
| Id | Choice | Recommendation and reason | Strongest alternative | Reverse |
| -- | ------ | ------------------------- | --------------------- | ------- |
| AS-1 | The switcher's apps are packaged by an esbuild `onLoad` plugin in tento-web (`AppSwitcherPlugin`) that replaces `@tento-brand/kit/app-switcher.packaged` from `app-switcher.json` and the `TENTO_APP_SWITCHER` switch | A build-time module, like `BuildStampPlugin`: when off, no link or icon is in the bundle at all, and it needs no Rust change, so a web-only release can ship it | A runtime `/app-switcher.json` the page fetches: simpler, but the data is a separate request and the off state is a missing file rather than a build input | Delete the plugin line in `bundler.deno.ts` and the mount; cheap. Since tento `c31a3a2d12` (2026-11-09) the manifest also carries the footer link and light/dark tokens, which `routes/app-switcher.ts` passes to the kit instead of its own studio link and colour CSS |
| AS-2 | **Operator ruling, 2026-11-08** ("a user who pulls the github does not get this app-switcher. it should be gated by some .env"): off by default. Only `TENTO_APP_SWITCHER=on` in the gitignored `html/.env` or the build's environment bundles it; nothing tracked turns it on. Superseded the agent's first choice, a checked-in `html/app-switcher.env` set to `on` | A clone of the repository builds with no switcher, links or icons | — | Lona's hosts keep an untracked `html/.env` with `TENTO_APP_SWITCHER=on`; the dev/prod web-only recipe copies it into the `git archive` export before `build-web` |
| AS-3 | **Superseded, operator 2026-11-09** ("we should probably copy the lona-switcher.json or keep it as some .env gitignored in the autophys repo"): `html/app-switcher.json` is a gitignored, byte-for-byte copy of tento's generated preset `tento-brand-lona-js/family/lona-switcher.json` (apps with inline tile SVGs, label, studio footer, light/dark tokens), kept on Lona's hosts beside `html/.env` and copied into every dev/prod export. The tracked manifest, `html/app-switcher/icons/*.svg` and its README are gone. Was (agent choice, 2026-11-08): a tracked manifest with the family tiles copied into `html/app-switcher/icons/` | A clone carries no Lona data at all, and the family look is defined once in tento | Vendor `tento-brand-lona-js/family` (228 KB) and derive the list from `LONA_FAMILY_APPS` | Recopy the preset when the family changes; restoring tracked copies is one commit; cheap |
| AS-4 | The switcher stays on in the workbench, wrapping the brand link that reads "Back to the deck" there | One brand position everywhere (BR-11); the card is how to reach the other apps from either page | Disable it while `data-app` is set | One attribute toggle in `brand.ts` |
| AS-5 | **Operator ruling, 2026-11-09** ("there should be no lona specific abstractions in autophys"): the tracked switcher code is product-neutral. `html/routes/app-switcher.ts`, `html/.env.example` and `.gitignore` describe a generic packaged switcher (`TENTO_APP_SWITCHER=on` plus an untracked `html/app-switcher.json` in tento-web's `AppSwitcherPlugin` format) and name no product; the label falls back to the kit's own default instead of a Lona string. Which apps, label, footer and colours appear comes only from the untracked manifest; where Lona's hosts get it lives in the deploy recipe outside the repository. The footer link's normal tracking moved upstream (tento `e8758d2cff`, repin-20261109d), so Autophys keeps no footer CSS | Autophys is a generic host of the generic switcher; a clone reads no Lona knowledge in code or comments | — | Restore the old comments and fallback label; one commit; cheap |
| AS-6 | **Agent-chosen, 2026-11-09, pending operator review** (operator: remove the remaining hostname gates). (a) The hackathon pill is gated by a build switch, `AUTOPHYS_HOSTED_BADGE=on` in the untracked `html/.env` or the build's environment, instead of a hostname check on the two hosted Autophys sites. Its copy and link moved to `html/routes/hosted-badge.switched.ts`, which tento-web's new generic `BuildSwitchPlugin` (tento `dc0cc8b825`, Change-Id I5b8e2d7a1c4f9063, vendored as repin-20261109e) bundles as written when the switch is on and replaces with `null` otherwise. (b) The overlay page scrollbar has no gate at all: it mounts on every host, clones and local daemons included, and still shows only on the landing stage. Autophys change: Change-Id If3a153421cd49237. The hosted build's `html/.env` on yuzuquats now also sets the switch on, so the live sites are unchanged | (a) The same off-by-default packaging rule as AS-2, under an Autophys name because the pill is Autophys's own content; with the switch off neither its text nor its link is in the bundle. The plugin is generic, so the next host-only module needs no bundler change. (b) The scrollbar is generic UI that replaces the native scrollbar the cookbook hides, so every host benefits | (a) Reuse `TENTO_APP_SWITCHER` as one "hosted packaging" switch: no tento change, but it ties an unrelated pill to the switcher. (b) Put the scrollbar behind a switch as well, so clones keep a page with no visible scrollbar | (a) Rename the switch, or fold it into another, in one Autophys commit; removing the plugin is a tento commit plus a re-vendor and re-pin. Cheap. (b) Re-adding a gate is a one-line change. Cheap |
```

Not vendored: tento's `bundler_reuse.rs` adds `TENTO_APP_SWITCHER` to the
reuse stamp. Here that is a Rust change and would need a native build;
`build-web` always writes a fresh folder, so only `serve`'s in-place rebuild
could reuse a tree built with the other switch value. Take it with the next
native vendor refresh.

Publication, 2026-11-09: the four app switcher commits were sunk to the
bottom of the local stack and pushed to `origin/master` as a fast-forward
`818aa7f..7059330` (Change-Ids I39ffdbbd329592f7, I4a844d6fb629bb94,
I210788a70c4aa891, I84ae536380a6217a). Agent review only, not an operator
verdict: three Opus rounds, the last "ready" (round 2 caught other sessions'
decisions.md edits leaking into the first commit during the sink; fixed
before the push). Checks on the pushed tree: `deno check`, plugin tests 9/9,
and `build-web` from an export, 0 switcher links in a clone build and 11 apps
with the host's `html/.env`. Still local: the re-vendored, hardened plugin
with its re-pin (it needs the unpublished vendor re-pin commits beneath it)
and the tento side (tento 6704015634, 6ac37afcce, 6c832e1518, 37640e76ac on
yuzuquats, which depend on the unpublished fleet-brand-rollout family header
commits). Production is not redeployed.
