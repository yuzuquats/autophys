# GitHub releases

## v0.1.0, 2026-11-07

Published at https://github.com/yuzuquats/autophys/releases/tag/v0.1.0 (marked
latest). The tag points at `59df761` ("Build release archives with their license
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
  pending.

  **REL-2 (operator, 2026-11-07): v0.1.1 includes `2659159`** ("Keep a running
  server's hydrated web tree out of pruning", Change-Id
  `I17218ce8d36112b9e81890d204114ac5`, written by another session). The
  operator authorized pushing it unchanged with the train fix and this record,
  after the full end-to-end and browser checks pass on both platforms. Without
  it, a packed `serve` running more than seven days loses its extracted web tree
  when another autophys starts, and answers 404. The rejected options were
  pushing only this session's commits (sunk below it) and waiting for its owner
  to push. Implementation: pending.

  The macOS executable is ad-hoc signed, not notarized.
- The vendor patch verifier was already failing before this release
  (vendor/README.md).
