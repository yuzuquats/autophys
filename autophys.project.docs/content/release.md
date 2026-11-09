# GitHub releases

## v0.1.4, 2026-11-08

Published at https://github.com/yuzuquats/autophys/releases/tag/v0.1.4 (marked
latest). Patch release (operator, 2026-11-08: "cut a new patch and deploy").
The tag (lightweight, created by `gh release`) points at `fe522fb`, the
version bump pushed in `cc04adb..fe522fb` (see the table). Nothing breaks 0.1.3
clients and the workbook format is unchanged. Since 0.1.3: one-line CLI errors
with a `--help` hint (G4), `AUTOPHYS_HOME` refused when it is a workbook file
or a `*.ap-workbook` folder (G3-FILE), a trailing slash naming the workbook
file in the CLI and the Rust SDK (HOME-SLASH), the unchecked-identifiability
wording in both SDKs (FINISH-WORDING), the full-tile favicon, the GitHub
header link, the account button kept out of the first paint, the full-width
sidebar below the shell's 760px narrow breakpoint, and a tutorial peek that
grows to fit its step.

| Commit | Change | Change-Id |
| --- | --- | --- |
| `b5cc6eb` | Grow the tour peek to fit its step | `I246a8997fae83902c64108da75c9c344` |
| `fe522fb` | Version autophys 0.1.4 | `I7f6348e6cb8999848946609ca1a78d62` |

| Asset | sha256 |
| --- | --- |
| `autophys-v0.1.4-x86_64-unknown-linux-gnu.tar.gz` | `a1fd97a486823bf29021dfb268d0ab6066d5bcd6cbf6c2440aa07846d46e453b` |
| `autophys-v0.1.4-aarch64-apple-darwin.tar.gz` | `d77b4dbc58206df5fa7201d61423991c0e715a34a5c20f198714d9de85518f70` |

### Review and validation

- The tour fix and the bump were reviewed in two agent rounds (round 1:
  tour fix ready, bump message changes required for an incorrect "no SDK
  change" claim; round 2 ready on the pushed SHAs). Agent review, not an
  operator verdict. The narrow-sidebar fix `cc04adb` was reviewed (ready) and
  pushed before it.
- Each archive was built by `ops/release.sh` from a fresh GitHub clone at
  `fe522fb` (full cargo and Deno suites and the packed smoke test): Linux on
  yuzuquats reusing the checkout's cargo cache, macOS on rwc-01 with its build
  tree on the SSD (deleted after; receipt in rwc-01
  `fleet/evidence/fleet-disk-policy/20261108/autophys-v0.1.4-macos/`).
- Downloaded back from the draft on rwc-01: both sha256 match, `codesign -v`
  passes, `--version` names `fe522fb`, and `serve` from the packed file with
  an empty HOME answers healthz (0.1.4) and `/app` 200. After publishing,
  anonymous downloads of both assets matched their sha256.
- Deployed: `autophys.service` on yuzuquats runs `fe522fb` (0.1.4) from
  `ops/deploy.sh` in the same clean clone (release `fe522fb-20261108`; unit
  preimage `autophys.service.pre-v0.1.4-20261108`; the `public.conf` drop-in
  is unchanged). `https://autophys.lona.so/api/healthz` reports 0.1.4, and a
  headless browser on production confirmed every tour step keeps Next 12px
  above the viewport bottom at 1280x800 and the sidebar fills 717px.
- Redeployed the same day at 18:27 as a web-only release on this binary:
  `fe522fb-web-818aa7f-20261108` (the case studies and pitch deck work,
  `fe522fb..818aa7f`), packed by `autophys pack` with the native prefix
  byte-identical to `fe522fb-20261108`, rehearsed on 127.0.0.1:4793, unit
  preimage `autophys.service.pre-web-818aa7f-20261108`. healthz still reports
  0.1.4 (`fe522fb`) with web_id `09d582e0…`.
- Redeployed 2026-11-08 19:22 as a web-only release on this binary:
  `fe522fb-web-7059330-20261109` (the Lona app switcher, `818aa7f..7059330`),
  built from a `git archive` of origin/master `7059330` plus the host's
  untracked `html/.env` (`TENTO_APP_SWITCHER=on`). The native prefix (26,443,358
  bytes) is byte-identical to the previous release; rehearsed on
  127.0.0.1:4793; unit preimage
  `autophys.service.before-fe522fb-web-7059330-20261109`. healthz reports 0.1.4
  (`fe522fb`) with web_id `846c4a95…`. A headless browser from rwc-01 opened
  the switcher on production: 11 apps, Autophys current, no console errors.

### Caveats

- `vendor/patches/autophys-bundler-context/verify.py` fails at this tag, as it
  already did at v0.1.3: the in-place cookbook edits no longer match either
  pinned manifest.
- The Linux binary needs glibc 2.39 or later; the macOS executable is ad-hoc
  signed, not notarized.

## v0.1.3, 2026-11-08

Published at https://github.com/yuzuquats/autophys/releases/tag/v0.1.3 (marked
latest). Patch release (operator, 2026-11-08: "cut a new patch and deploy").
The tag (lightweight, created by `gh release`) points at `d7a7db8`, the
version bump pushed above `9e07fab`. It carries the 2026-11-08 review
decisions ([review-20261108-implementation.md](review-20261108-implementation.md)):
workbook format 2, the batch records endpoint replacing the attachment route,
`project(name)` opening only, the async Rust transport with its blocking
facade and connection reuse, the typed `Trajectory` without output indexing,
measurement hashes in `data_attached`, and self-hashing built-in models.

**Breaking:** SDK 0.1.x clients cannot attach data to a 0.1.3 daemon, and
0.1.x tools cannot open a format 2 workbook. A direct `HttpStore.attach_data`
retry of a pair first written by an older Python SDK returns
`idempotency_conflict`; `Investigation.attach_data` is unaffected. Projects
using the oscillator or thermal built-ins see a one-time config change.

| Commit | Change | Change-Id |
| --- | --- | --- |
| `d7a7db8` | Version autophys 0.1.3 | `I0d5b8e2a7c4f19063d5b8e1a7c4f2e96` |

| Asset | sha256 |
| --- | --- |
| `autophys-v0.1.3-x86_64-unknown-linux-gnu.tar.gz` | `c2073f0757b65c1a26ae92f708757038cbf735bd16dc836155323f73ef5acdec` |
| `autophys-v0.1.3-aarch64-apple-darwin.tar.gz` | `8ab8cb36dcdd8eab7f33bbca97a39e649440150a829749cd48d98d989ae8682f` |

### Review and validation

- The changes were reviewed in two agent rounds before the `0cfc49d..9e07fab`
  push (ready), and the bump in a third (ready, base `9e07fab`). Agent
  review, not an operator verdict.
- Each archive was built by `ops/release.sh` from a fresh GitHub clone at
  `d7a7db8` (full cargo and Deno suites and the packed smoke test): Linux on
  yuzuquats, macOS on rwc-01 with its build tree on the SSD (deleted after).
- Downloaded back from the draft and checked on macOS with isolated homes:
  sha256, `codesign -v`, `--version` names `d7a7db8`, `autophys new --lang
  python` pinned the SDK to the commit, the local walkthrough (validated,
  held-out chi2/N 1.04, verify ok), `serve` from the packed file (healthz,
  `/app` 200), device pairing and `whoami`, and the walkthrough over HTTP
  (validated; the `data_attached` record names its measurement by record
  hash). After publishing, anonymous `curl` downloads of both assets matched
  their sha256, the macOS executable carried no quarantine attribute, and
  both report `0.1.3 (d7a7db8)`.
- Deployed: `autophys.service` on yuzuquats runs `d7a7db8` (0.1.3) from
  `ops/deploy.sh` in the same clean clone; healthz, `/app` and
  `https://autophys.lona.so/api/healthz` answer 200.

### Caveats

- No headless browser check of `/app` this release; only HTTP status.
- The pooled-client idle time (4 s) leaves about 0.5 s of margin against a
  directly connected daemon's 5 s keep-alive (review of `9e07fab`).
- The Linux binary needs glibc 2.39 or later; the macOS executable is ad-hoc
  signed, not notarized.

## v0.1.2, 2026-11-07

Published at https://github.com/yuzuquats/autophys/releases/tag/v0.1.2 (marked
latest). Patch release: the operator asked for a patch, not a minor, until they
say otherwise. The tag (lightweight, created by `gh release`) points at
`7b963a3`, the tip of the push `7619174..7b963a3`: the examples/backtest work
in [examples.md](examples.md) (EX-1 to EX-11), CLI-16, the version bump and a
follow-up fix.

| Commit | Change | Change-Id |
| --- | --- | --- |
| `8fc88f6` | Spec examples as templates, demos and backtests | `Ia37e14ff3321c72591c3c44fdedf6e81` |
| `ad2789b` | Record the examples and CLI-16 decisions | `I4d32ec0ee02b0f68073911d5ed8faab4` |
| `5b6cc13` | Record EX-9: one --example flag selects what bench runs | `I26f894e429fa05cc9ff805a86d2a4bd8` |
| `d3e99dd` | Record EX-10: scheme references with #case for --example | `Ia50765524077f7c9a77a5c941fd3e68c` |
| `00bb473` | Declare the benchmark cases as backtest examples | `I91c47241e650e419b25036afffb9d6ed` |
| `4b27ce0` | Give examples kinds and select backtests with --example | `I124d47e38ec757fbc1b16e66fa4cec3c` |
| `ab32da9` | Draw backtest truth per seed, replay recorded runs and score models | `I7b089d8708e3d55fa14b85f8db6a0e7b` |
| `57e68a9` | Split the training workers code cache from their outputs (CLI-16) | `Iefadf53750e7f250dd0b271bea961111` |
| `6bdab8f` | Add a backtest of synthesized recorded battery runs | `Idf714b108e003ed71e0028554533d250` |
| `4b0d205` | Say why live bench runs fail, and record the live backtests | `Icbb9bbcae7a1e9a069c8506b212db436` |
| `de7aa0a` | Version autophys 0.1.2 | `Ib376c04887b632e76308c0fe6bab86af` |
| `7b963a3` | Let training workers take any backtest case, and fix stale example paths | `I1e88b81ef023c5060c30e87922889e6a` |

| Asset | sha256 |
| --- | --- |
| `autophys-v0.1.2-x86_64-unknown-linux-gnu.tar.gz` | `6430d77cd82ad34cd5dcb2245d2c54ad83a9f27b006f49e3d66004da4727248b` |
| `autophys-v0.1.2-aarch64-apple-darwin.tar.gz` | `9bc2384838c8206481105ec8697fbaec7ab61e391a61f5ecf8c89dd59241e728` |

### Review

Agent review, not an operator verdict. Round 1 (Claude Opus 5.5 on API
credits, a one-off exception the operator authorized after the Codex review
stalled and both non-credit Claude routes were rate-limited) returned ready,
with non-blocking findings; `7b963a3` fixed three of them (`train dataset`
crashed on planted cases, `train eval` put reference ids in file names, stale
`examples/battery-fit/` paths). Round 2 (same reviewer) checked the fix, the
patch ids of the reordered commits and the trailers, and returned ready.
Receipt: `yuzuquats:~/.local/state/tento/reviews/autophys/examples-v0.1.2-20261107.md`.

### Validation

- The pushed prefix, from a `git archive` export: 313 Rust tests, Python SDK
  621 passed (13 skipped), train/sft 38 passed, `autophys examples --check`
  clean.
- Each archive was built by `ops/release.sh` from a fresh clone of GitHub at
  `7b963a3` (local `master` carried another session's unpublished commits),
  with `CARGO_TARGET_DIR` passed explicitly; the script ran the full cargo and
  Deno suites and its packed smoke test. Linux built on yuzuquats. macOS built
  on rwc-01's boot volume (operator-authorized one-off: its external SSD was
  mounted but every access failed with "Interrupted system call"), and the
  build tree was deleted afterwards.
- Both assets were downloaded back from the draft and checked with isolated
  homes: sha256, `--version` names `7b963a3`, `autophys new --lang python`
  pinned the SDK to the commit, the README walkthrough (validated, held-out
  chi2/N 1.04, verify ok), `serve` from the packed file (web_id `3e8f0bf7…`
  Linux, `789df627…` macOS), pairing and `whoami`, the walkthrough over HTTP,
  and headless Chrome on `/` and `/app` (through `tento-headless-js`; no
  console, page or request errors; the investigations show validated).
- New in this release: with an empty dataset cache, `bench --example
  battery-recorded --policy scripted` downloaded the recorded runs from GitHub,
  verified their sha256 and validated both cases (max relative error 1.07%).
- After publishing, anonymous `curl` downloads of both assets matched their
  sha256 and served healthz and `/app`; the macOS executable passed
  `codesign -v` and carried no quarantine attribute.

### Caveats

- On yuzuquats (Ubuntu), chrome-headless-shell needs `--no-sandbox`: AppArmor
  blocks unprivileged user namespaces. The check loaded only the local app.
- Open, from review: training runs made before CLI-16 are not found in the new
  data directory unless `--data-dir` points there, so `--resume` starts a new
  loop; `--seeds N` on a recorded case repeats identical replays; `bias` and
  `missing` are ignored for recorded cases; a wheel built with current
  setuptools has not been checked for the backtest package data.
- EX-11 (fixed truth by default) is deferred by the operator (2026-11-08)
  until the first fine-tune evaluation or real research-loop run.
- The Linux binary needs glibc 2.39 or later; the macOS executable is ad-hoc
  signed, not notarized.

## v0.1.1, 2026-11-07

Published at https://github.com/yuzuquats/autophys/releases/tag/v0.1.1 (latest
until v0.1.2). The annotated tag points at `090512e`, the tip of the push
`59df761..090512e`:

| Commit | Change | Change-Id |
| --- | --- | --- |
| `2659159` | Keep a running server's hydrated web tree out of pruning (another session's; REL-2) | `I17218ce8d36112b9e81890d204114ac5` |
| `8439533` | Record the v0.1.0 release and fix stale deploy docs | `I27f47c301f4bce59cdf6f63c3e5aca27` |
| `bf22591` | Write train diagnostics on macOS when stderr is a pipe (REL-1) | `I9bfa2b90f058aa54e769738e13564622` |
| `7c58f08` | Keep train lifecycle setup waits out of the behavior budgets | `I795a41d0244cb591aa655c554cd38cbe` |
| `da986de` | Version autophys 0.1.1 | `If84117e59f34f67a60949d25dfa94ec7` |
| `4910701` | Start the READMEs from a release instead of a Rust build | `I0e3f59ed670cd186b054c038074ea813` |
| `090512e` | Show why pair approve failed in the connect --json test | `I562c8093d870121c04c9d64a8f727e31` |

| Asset | sha256 |
| --- | --- |
| `autophys-v0.1.1-x86_64-unknown-linux-gnu.tar.gz` | `dbb1ee17bcbd11f97053b4205969336a16188d9bc26e4e4a4e46372d3b0987f2` |
| `autophys-v0.1.1-aarch64-apple-darwin.tar.gz` | `a0c9f7de9ecd61e2b4c531b5a2c275f3a773fded69e953c6cb23027323475a50` |

`ops/release.sh` built each archive from `090512e` (Linux on yuzuquats, macOS on
rwc-01 with its output on the SSD), running the full cargo and Deno suites, the
pack and the packed smoke test. The archives were uploaded to a draft,
downloaded back, and checked as for v0.1.0 (below) on each platform: sha256,
`--version`, `autophys new` with the SDK from GitHub at `090512e`, the local
walkthrough (validated, held-out chi2/N 1.04, verify ok), `serve` from the
packed file (web_id `6ed446e3…` Linux, `aa623760…` macOS), pairing, the same
walkthrough over HTTP (2 validated investigations), and headless Chrome on `/`
and `/app` with no console, page or request errors (macOS through
`tento-headless-js`). The in-app manual served by the Linux build contains the
new release links. After publishing, anonymous `curl` downloads of both assets,
installed with the README's commands, matched their sha256 and served healthz
and `/app`; the macOS executable passed `codesign -v` and carried no quarantine
attribute. The v0.1.0 notes now send macOS users to v0.1.1.

On macOS, all 13 `train_lifecycle` tests pass. Before `7c58f08`, one of them
failed in about half of full-suite runs: its 3 s setup window included
launching the CLI, and the first launch of a freshly linked 100 MB debug binary
took about 4 s (traced from spawn to `main`). Setup waits now allow 30 s, and
each test process launches the CLI once before timing anything; the behavior
bounds are unchanged.

### Caveats

- **`connect_with_json_keeps_stdout_one_object` (tests/user_cli.rs) is flaky.**
  `pair approve` exited nonzero once in the first Linux build of `4910701` and
  once in about 90 runs under load; every isolated rerun passed. The cause is
  unknown. `090512e` makes the assertion print the code it parsed and approve's
  output, for the next occurrence. The pairing code is unchanged since v0.1.0.
- The macOS end-to-end check first ran with `/usr/bin/python3` (3.9.6) ahead of
  Homebrew on PATH; `autophys new` then failed cleanly, because the template
  needs Python 3.10 or newer, as the README says. The passing run used
  Homebrew's Python 3.15. A Mac whose first `python3` is the system one gets
  that failure, with the recovery steps printed.
- The Linux binary needs glibc 2.39 or later; the macOS executable is ad-hoc
  signed, not notarized.
- `build-web` gives each platform a different web_id for the same commit.
- The vendor patch verifier was already failing (vendor/README.md).

## v0.1.0, 2026-11-07

Published at https://github.com/yuzuquats/autophys/releases/tag/v0.1.0 (latest
until v0.1.1). The tag points at `59df761` ("Build release archives with their license
notices"), above `16e514d` (the license, LIC-1 and LIC-2 in
[decisions.md](decisions.md)).

| Asset | sha256 |
| --- | --- |
| `autophys-v0.1.0-x86_64-unknown-linux-gnu.tar.gz` | `1e1f486b6250cfd5d01fbfdeaeb2a68426189ef60a276f0f94e55218720118eb` |

Each archive holds the packed `autophys` (web app embedded, B-1), `LICENSE-MIT`,
`LICENSE-APACHE`, `NOTICE`, `README.md` and `THIRD-PARTY-LICENSES.txt` (written by
`ops/third-party-licenses.py`: 434 third-party crates, 37 covered by NOTICE, plus
`licenses/web-editors.txt`). `ops/release.sh --out-dir DIR` builds one host's
archive and runs a smoke test on it, with isolated state.

### Validation

The asset was downloaded from the release and checked on yuzuquats, with an
isolated HOME and only the release directory on PATH:

- The sha256 matches, and `--version` names `59df761`.
- `autophys new --lang python` installed the SDK from GitHub, pinned to the same commit.
- The README walkthrough ran locally: `start --simulate` left an unidentified
  parameter, `approve` was accepted, `continue --simulate` reached `validated`
  (held-out chi2/N 1.04), and `verify` was ok.
- `serve` served the embedded app: `/api/healthz` reports the commit and web_id
  `fa4c546d…`, and `/`, `/app` and `/index.root.js` returned 200.
- `connect` and `pair approve` paired the device, and `whoami` worked.
- The walkthrough repeated against the server over HTTP: 2 validated
  investigations, and `verify` was ok with 38 records.
- Headless Chrome loaded `/` and `/app` with no console, page or request
  errors, and showed both investigations validated.
- After publishing, an anonymous `curl` download from the public URL matched
  the sha256, served healthz, and returned 200 for `/app`.

### Caveats

- The Linux binary needs glibc 2.39 or later (Ubuntu 24.04, Debian 13).
- **macOS arm64 is not attached to v0.1.0.** The first macOS build on rwc-01
  failed in `train_lifecycle` while the external SSD was being force-unmounted,
  and that was first taken as the cause. A rerun on a healthy disk failed the
  same way, so the cause is a real bug: on macOS, `autophys train run` exits 1
  with no output whenever stderr is a pipe. `Diagnostics::open()` in
  `src/train.rs` reopens `/dev/stderr` for an independent nonblocking handle
  (R2-D1); macOS returns the shared open file description, so the open is
  refused, and `Failure::report` uses the same path, so the error is silent.
  Every other suite passed on macOS (33 Rust suites, 129 Deno tests).

  **REL-1 (operator, 2026-11-07): fix it and release v0.1.1 for Linux and
  macOS; v0.1.0 stays as published.** The fix keeps R2-D1's intent: where an
  independent nonblocking handle is unavailable, write to stderr only when
  `poll()` reports it writable, in chunks no larger than `PIPE_BUF`, and never
  drop the failure report silently; a piped-stderr regression test covers it.
  The rejected options were attaching the v0.1.0 macOS build with a known-issue
  note (training broken, silently) and leaving macOS out. Implementation:
  done in `bf22591` and shipped in v0.1.1. It also covers a Linux stderr that
  cannot be reopened (a socket), which previously failed the same way.

  **REL-2 (operator, 2026-11-07): v0.1.1 includes `2659159`** ("Keep a running
  server's hydrated web tree out of pruning", Change-Id
  `I17218ce8d36112b9e81890d204114ac5`, written by another session). The
  operator authorized pushing it unchanged with the train fix and this record,
  after the full end-to-end and browser checks pass on both platforms. Without
  it, a packed `serve` running more than seven days loses its extracted web tree
  when another autophys starts, and answers 404. The rejected options were
  pushing only this session's commits (sunk below it) and waiting for its owner
  to push. Implementation: done; pushed unchanged in `59df761..090512e` and
  shipped in v0.1.1.

  The macOS executable is ad-hoc signed, not notarized.
- The vendor patch verifier was already failing before this release
  (vendor/README.md).

## Lona-hosted builds turn on the app switcher

The Lona family app switcher is off in any build of the repository as
checked out (operator, 2026-11-08; decision AS-2). Lona's hosted builds,
autophys.lona.so and dev--autophys.lona.so, turn it on: copy the host's
untracked `html/.env` (`TENTO_APP_SWITCHER=on`, see `html/.env.example`)
into the `git archive` export before `build-web`, or run `build-web` with
`TENTO_APP_SWITCHER=on`. Check the bundle carries it: `routes/index.root.js`
contains `autotrade.lona.so`. A release built without the switch ships no
switcher, which is correct for builds made outside Lona.

## Deck fixes and cookbook re-vendor published (2026-11-08)

Pushed autophys 7059330..a43ed9b: the simplified cases slide, the short-phone
deck layout with header and footer fade bands, hero stats as rows on phones,
the 8/8 stat removed, and the vendor re-pin. The cookbook changes went
upstream first (tento 54edca64ef, project tento-cookbook), and a43ed9b
re-vendors them from there. Two read-only agent reviews returned ready;
receipt: `fleet/evidence/autophys-cookbook-sink-20261108/receipt.md`.
Production is not deployed with these changes; dev--autophys.lona.so has them.
The html boundary test fails on origin since the app switcher added
`html/app-switcher/`; that is open for its owner.

## Family header deployed to production (2026-11-09)

Operator chose option B from the header mocks and said to deploy directly
when finished. 659b8c9 gives Autophys the Lona family header with one 8px
margin: the 64px bar, the 28px mark at (40, 18), the app's header card 8px
from the top and sides and 48px tall, the panels 8px under it and 8px apart.
The release is web-only, built from dcccbb2 (it also carries the approved
page scrollbar 23ddcf7 and dcccbb2):
`services/autophys/1d5d193-web-dcccbb2-20261109`, native 1d5d193 with a
byte-identical prefix (26531408 bytes), web_id 7a9f77f5…. It was rehearsed on
4793, and the unit backup is `autophys.service.before-1d5d193-web-dcccbb2-20261109`.
Measured on autophys.lona.so at 1280 and 390 wide: the header is 64px, the
mark is at (40, 18) (x 20 on the phone landing), the menubar is at (8, 8) and
48px tall, the panels start at y 64, and the switcher is present. Unpushed.

## Hosted pill, header slide fix and page scrollbar published (2026-11-09)

Pushed autophys 725f629..ef771dd:
- the "Built for Meta Global Hacks" pill above the docs, linking the event page;
- the fix for the header logo sliding in on load;
- the overlay page scrollbar. On touch screens it is an indicator only.

The pill and the scrollbar mount only on autophys.lona.so and dev--autophys.lona.so. The scrollbar is no longer a dev-only prototype: the operator approved it for production. Production already serves this web, as release `1d5d193-web-dcccbb2-20261109` (web from local dcccbb2, which also carries the family header change). Its earlier SOURCE note calls the scrollbar dev-only, which is no longer true.

Two read-only agent reviews returned ready. Their non-blocking notes:
- a touchscreen laptop still routes touches on the 14px strip to the bar;
- the hosted-host check is duplicated in hosted-badge.ts and page-scrollbar.ts.

The deck-fixes section above says production was not deployed. That was true when it was written; production now has those changes.

## App switcher drawn with std-round, deployed (2026-11-09)

Bringing every Lona site to the current switcher (handoff from
family-of-apps/header). a1b900e re-vendors tento 6d3ad0bed1's
kit/app-switcher.ts (std-round card, plus 46a7e3faa4 and b15334333a) and
re-pins the manifest (repin-20261109). Hazard checked: std-round is defined
once. The switcher, the cookbook and the workbench all import
@tento-ui/components/round through the html import map, and one bundle
(routes/index.root.js) carries it. Neither dev nor production logs any
console error or "already registered".

- Dev: `autophys-dev/a1b900e-web-20261109041543`.
- Production: `services/autophys/1d5d193-web-a1b900e-20261109`, native
  1d5d193 with a byte-identical prefix (26531408 bytes), web_id 1016e51f….
  Rehearsed on 4793. Unit backup:
  `autophys.service.before-1d5d193-web-a1b900e-20261109`.
- Measured on autophys.lona.so: the switcher opens on the landing and in the
  app with 11 tiles, and its card is a std-round at (28, 6), 373 by 344.
- Unpushed.

## Refreshed switcher icons deployed (2026-11-09)

4756336 copies the family tiles again from tento's GENERATED_TILES
(manifest b5502700…). Autotrade (dot on its path) and Brand (swatch pair)
changed. The release also carries 5266733 (no brand focus ring, a 30px
profile control).

- Dev: `autophys-dev/4756336-web-20261109042351`.
- Production: `services/autophys/1d5d193-web-4756336-20261109`, native
  1d5d193 with an identical prefix, web_id a1197da3…. Rehearsed on 4793.
  Unit backup: `autophys.service.before-1d5d193-web-4756336-20261109`.
- Checked by opening the switcher on autophys.lona.so: the new icons show and
  the page logs no errors.

## Back arrow room deployed (2026-11-09)

283bfc0: in the app the mark slides to x 56, and the back arrow sits at
x 24, 16px inside the header card (at x 14 it had been 6px from the edge).
The landing keeps x 40. The release also carries ce1476e (the guided tour's
ring).

- Dev: `autophys-dev/283bfc0-web-20261109042739`.
- Production: `services/autophys/1d5d193-web-283bfc0-20261109`, web_id
  5e44fe66…, identical native prefix, rehearsed on 4793. Unit backup:
  `autophys.service.before-1d5d193-web-283bfc0-20261109`.
- Measured on autophys.lona.so at 1280 and 390 wide: in the app the arrow is
  at x 24 and the mark at x 56.

## Case-study illustrations deployed (2026-11-09)

7d3c8d7: the "Small language model self-monitoring" row now shows a set
sentence ("The Eiffel Tower opened in 1889.") with a span under each token
whose length stands for its logit margin, the short one, under the year, in
ink. The "Energy budget of an evolving particle world" row shows the same
lattice world twice, a short grey sunlight pulse over one and a long ink step
over the other, with equal inflow into the creatures in both. Both are
captioned "illustration, planned test". The operator picked them (slm D, nrg
L5) from judged variants in `~/.cache/autophys-dev-build/illus-v3/round4/`.

- Production: `services/autophys/1d5d193-web-7d3c8d7-20261108`, web_id
  96419fce…, built from 7d3c8d7 (= 283bfc0, the previous release's web
  source, plus this change and a docs note) with `html/.env`; identical
  native prefix, rehearsed on 4793. Unit backup:
  `autophys.service.before-1d5d193-web-7d3c8d7-20261108`. Rollback:
  `1d5d193-web-283bfc0-20261109`.
- Checked on autophys.lona.so: both captions read "illustration, planned
  test", the Eiffel sentence renders, the three "Open in workbench" buttons
  remain, `/open/demo/workbook/thermal_rc_demo` answers 200.

## Header, switcher and icons published (2026-11-09)

Pushed origin/master 5266733..1a7daa1 (10 commits, sunk below 8 local peer
drafts that stay local). The release notes above cite the commits by their
pre-sink SHAs; their Change-Ids map them to the published commits:

- I1049bf4eecfb97a8 7b23d0f: the family header with one 8px margin.
- I0a7d5c3e9f1b6284 53bf2d3 and I4d2b9e6f0a8c1375 1a7daa1: the back arrow's
  room and its phone comment.
- I5c2e8b7a1d4f9036 443a389: the std-round switcher re-vendor and
  repin-20261109. It sits on the peer re-vendor Ib9ea420dc0b7c4ad (dee9ecc),
  which is included as its dependency.
- I3b8f0d6a2c9e7154 b5d0177: the refreshed icons.
- I7f3c9a1e5b2d8046, I9d1a6e3c7b5f2804, I6e4c2a9f1b7d3058 and
  I8c3f1e7a5d9b2460: the deploy records.

The provenance.json repin `commit` fields still name local SHAs (a337ff88,
b8c0435e); verify.py checks only the hashes. Two read-only agent reviews
returned ready. Receipt:
`fleet/evidence/autophys-header-switcher-sink-20261109/receipt.md`.

## studio.lona.so switcher footer deployed (2026-11-09)

02f874d re-vendors tento-brand-js/kit/app-switcher.ts from upstream tento
823e73ac19 (the card's footer slot, re-pinned as repin-20261109b), and
9671892 fills that slot: "Product design and engineering" with a muted
"studio.lona.so ↗", target _blank rel noopener, styled as the family
header's light row (tinted, 10px 12px, cell radius, 12.5px/500 with an
11.5px/400 #6a6e66 address that wraps under the label on narrow cards). The
values are copied from tento-brand-lona-js family/products.ts
LONA_STUDIO_LINK. Studio has no tile.

- Dev: `services/autophys-dev/9671892-web-20261108204706`.
- Production: `services/autophys/1d5d193-web-9671892-20261108`, web_id
  7332ffcf…, built from 9671892 with `html/.env`. Since the previous release's
  web source 7d3c8d7, the only web changes are this one and a comment. The
  native prefix is identical (26531408 bytes), and it was rehearsed on 4793.
  Unit backup: `autophys.service.before-1d5d193-web-9671892-20261108`.
  Rollback: `1d5d193-web-7d3c8d7-20261108`.
- Checked headless on both hosts at 1280 and 340 px: the footer shows below
  the 11 tiles, href/target/rel are correct, there are no page or console
  errors, std-round is defined once, and "Lona Studio" appears nowhere.
