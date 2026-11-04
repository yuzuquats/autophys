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
