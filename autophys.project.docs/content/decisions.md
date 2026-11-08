# autophys decisions: what the operator ruled and what agents chose

Status: rev 1, 2026-11-04. This page is the index of autophys decisions.
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
| DM-D1 | **Changed: format 2.** The display table becomes a coordinated format-2 workbook migration in both SDKs instead of an optional table in format 1; released SDKs (<= 0.1.2) will refuse format-2 workbooks. Agent recommended keeping format 1. Open sub-question **DM-D1a** (ask before implementing): both SDKs migrate on open today, so one open with a new SDK would lock any workbook out of 0.1.x; upgrade on open, or only when a display is first written | **not implemented** (format 1 with the optional table is still what ships) |
| CORE-01 | **Changed: a generic batch API.** A general multi-record transaction endpoint replaces the dedicated attachment route. Agent recommended keeping the dedicated route with no fallback. Open sub-question **CORE-01a**: whether the shipped `/proposals/{pid}/attachment` route stays as a compatibility alias | **not implemented** (the dedicated route is still what ships) |
| CORE-02 | Confirmed: refuse configuration drift before run/approve/attach/resume; one investigation, one config. Finding A3 (tools that bypass the check) stays open | built |
| CORE-03 | Confirmed: normalise equivalent daemon URLs, reject ambiguous targets before effects, scope saved keys to the normalised identity | built |
| CORE-04 | **Changed: unify on open.** `project(name)` opens an existing project and errors if missing in both SDKs; Rust callers that rely on create use `ensure_project`. Agent recommended this (beyond the additive pair that was built), for AX-2 parity at 0.x | **not implemented** (Rust `project(name)` still creates) |
