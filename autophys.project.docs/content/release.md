# GitHub releases

## v0.1.1, 2026-11-07

Published at https://github.com/yuzuquats/autophys/releases/tag/v0.1.1 (marked
latest). The annotated tag points at `090512e`, the tip of the push
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
